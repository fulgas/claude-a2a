// Authentication and agent card signatures for both sides of the bridge, as the A2A specification sets them out
// (sections 4.5, 7 and 8.4).
//
// Server: any of an API key in the X-API-Key header, a JWT from an OpenID Connect or OAuth 2.0 issuer as a bearer
// token (with the scopes it must carry), and mutual TLS, which every connection must then pass as well. It signs its
// agent card with a configured key and publishes the public key beside it.
// Client: reads the remote agent's card, picks the first security requirement it can meet (one met without a person
// first), and sends what it asks for: an API key in a header, cookie or query parameter; HTTP Bearer or Basic; or an
// OAuth 2.0 token from the client-credentials, device-code or authorization-code (PKCE) grant, found through the
// card's flows, its oauth2MetadataUrl or its OpenID Connect discovery document. Tokens are cached and refreshed.
import { createHash, createPrivateKey, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'

import { generateAgentCardSignature, verifyAgentCardSignature } from '@a2a-js/sdk'
import { calculateJwkThumbprint, createRemoteJWKSet, errors, jwtVerify } from 'jose'

export const API_KEY_HEADER = 'X-API-Key'
// Asymmetric algorithms only: a key set from the issuer never verifies an HMAC token signed with a public key.
const JWT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

const sameSecret = (a, b) => {
  const [x, y] = [Buffer.from(String(a)), Buffer.from(String(b))]
  return x.length === y.length && timingSafeEqual(x, y)
}
const isLoopback = hostname => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)

async function getJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

/**
 * An issuer's metadata: its OpenID Connect discovery document, or else its OAuth 2.0 authorization server metadata
 * (RFC 8414, which puts the well-known part before the issuer's path).
 */
async function issuerMetadata(issuer) {
  const oidcUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
  const { origin, pathname } = new URL(issuer)
  const oauthUrl = `${origin}/.well-known/oauth-authorization-server${pathname === '/' ? '' : pathname}`
  for (const [url, isOidc] of [
    [oidcUrl, true],
    [oauthUrl, false],
  ]) {
    const metadata = await getJson(url).catch(() => undefined)
    if (!metadata) continue
    if (metadata.issuer !== issuer)
      throw new Error(`issuer mismatch: ${url} names "${metadata.issuer}", not "${issuer}"`)
    return { url, metadata, isOidc }
  }
  throw new Error(`${issuer} serves neither ${oidcUrl} nor ${oauthUrl}`)
}

/**
 * Counts events per key in a fixed one-minute window: failed sign-ins per gRPC peer, tasks per caller.
 * A limit of 0 never fills.
 */
export function perMinute(limit, windowMs = 60_000) {
  const windows = new Map()
  const current = key => {
    const entry = windows.get(key)
    if (entry && Date.now() - entry.since < windowMs) return entry
    const fresh = { since: Date.now(), count: 0 }
    windows.set(key, fresh)
    return fresh
  }
  return {
    isFull: key => limit > 0 && current(key).count >= limit,
    add: key => {
      current(key).count++
    },
  }
}

// ---------- server ----------

/**
 * The server's authenticator. With no API key, issuer or client CA, every request passes as `anonymous`.
 * `authenticate({ headers, peer })`, where `peer` is the subject of a verified client certificate, resolves
 * `{ caller }`, or `{ error }` when the request must be refused: `missing`, `invalid_token` or `insufficient_scope`.
 * `challenges(error)` are the WWW-Authenticate values for a refusal.
 */
export async function serverAuth({ apiKey, issuer, audience, scopes = [], mtls = false }) {
  if (issuer && !audience)
    throw new Error('--oidc-issuer needs --oidc-audience: a JWT for another service must not pass')
  if (scopes.length && !issuer) throw new Error('--required-scopes needs --oidc-issuer: only a JWT carries scopes')

  let verifyJwt
  const securitySchemes = {}
  const alone = [] // scheme names, each enough by itself
  if (apiKey) {
    securitySchemes.apiKey = { apiKeySecurityScheme: { location: 'header', name: API_KEY_HEADER } }
    alone.push('apiKey')
  }
  if (issuer) {
    const { url, metadata, isOidc } = await issuerMetadata(issuer)
    const keys = createRemoteJWKSet(new URL(metadata.jwks_uri))
    verifyJwt = token => jwtVerify(token, keys, { issuer, audience, algorithms: JWT_ALGORITHMS, clockTolerance: 30 })
    if (isOidc) {
      securitySchemes.oidc = { openIdConnectSecurityScheme: { openIdConnectUrl: url } }
      alone.push('oidc')
    } else {
      // OAuthFlows holds one flow, so each grant the issuer offers is a scheme of its own.
      const scopeMap = Object.fromEntries(scopes.map(s => [s, s]))
      const flows = {
        oauth2: metadata.token_endpoint && {
          clientCredentials: { tokenUrl: metadata.token_endpoint, scopes: scopeMap },
        },
        'oauth2-device': metadata.device_authorization_endpoint && {
          deviceCode: {
            deviceAuthorizationUrl: metadata.device_authorization_endpoint,
            tokenUrl: metadata.token_endpoint,
            scopes: scopeMap,
          },
        },
        'oauth2-code': metadata.authorization_endpoint && {
          authorizationCode: {
            authorizationUrl: metadata.authorization_endpoint,
            tokenUrl: metadata.token_endpoint,
            scopes: scopeMap,
            pkceRequired: true,
          },
        },
      }
      for (const [name, flow] of Object.entries(flows)) {
        if (!flow) continue
        securitySchemes[name] = { oauth2SecurityScheme: { oauth2MetadataUrl: url, flows: flow } }
        alone.push(name)
      }
    }
  }
  // The TLS layer refuses a connection without a client certificate, so mutual TLS goes with every other scheme.
  if (mtls) securitySchemes.mtls = { mtlsSecurityScheme: {} }
  const securityRequirements = (alone.length ? alone : mtls ? [undefined] : []).map(name => ({
    schemes: {
      ...(name && { [name]: { list: name === 'apiKey' ? [] : scopes } }),
      ...(mtls && { mtls: { list: [] } }),
    },
  }))
  const isConfigured = Boolean(apiKey || verifyJwt || mtls)

  async function authenticate({ headers, peer }) {
    if (!isConfigured) return { caller: 'anonymous' }
    if (mtls && !peer) return { error: 'missing' }
    if (!apiKey && !verifyJwt) return { caller: `mtls:${peer}` }
    const key = headers[API_KEY_HEADER.toLowerCase()]
    if (apiKey && key && sameSecret(key, apiKey)) return { caller: 'api-key' }
    const bearer = /^Bearer (.+)$/i.exec(headers.authorization ?? '')?.[1]
    if (!verifyJwt || !bearer) return { error: 'missing' }
    try {
      const { payload } = await verifyJwt(bearer)
      const granted = new Set(
        typeof payload.scope === 'string' ? payload.scope.split(' ') : Array.isArray(payload.scp) ? payload.scp : [],
      )
      if (!scopes.every(s => granted.has(s))) return { error: 'insufficient_scope' }
      return { caller: payload.sub ? `oidc:${payload.sub}` : 'oidc' }
    } catch (err) {
      if (err instanceof errors.JOSEError) return { error: 'invalid_token' }
      throw err
    }
  }

  // RFC 6750 section 3 for the bearer token; the API key has no registered scheme, so its challenge names the header.
  const challenges = error => [
    ...(verifyJwt
      ? [
          [
            'Bearer realm="a2a"',
            error !== 'missing' && `error="${error}"`,
            scopes.length && `scope="${scopes.join(' ')}"`,
          ]
            .filter(Boolean)
            .join(', '),
        ]
      : []),
    ...(apiKey ? [`APIKey realm="a2a", in="header", name="${API_KEY_HEADER}"`] : []),
  ]

  return { authenticate, challenges, securitySchemes, securityRequirements, isConfigured }
}

/**
 * Signs the agent card (section 8.4) with a private key from a PEM or JWK file: ES256/384/512 for EC keys, EdDSA for
 * Ed25519, RS256 for RSA. The key id is the public key's JWK thumbprint (RFC 7638), and `jku` names where the
 * public key set is served.
 */
export async function cardSigner(path, jku) {
  const text = readFileSync(path, 'utf8')
  const privateKey = createPrivateKey(text.trim().startsWith('{') ? { key: JSON.parse(text), format: 'jwk' } : text)
  const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' })
  const alg =
    privateKey.asymmetricKeyType === 'ec'
      ? { 'P-256': 'ES256', 'P-384': 'ES384', 'P-521': 'ES512' }[publicJwk.crv]
      : { ed25519: 'EdDSA', rsa: 'RS256' }[privateKey.asymmetricKeyType]
  if (!alg) throw new Error(`${path}: an EC (P-256, P-384, P-521), Ed25519 or RSA key is needed to sign the card`)
  const kid = await calculateJwkThumbprint(publicJwk)
  return {
    sign: generateAgentCardSignature(privateKey, { alg, kid, typ: 'JOSE', jku }),
    jwks: { keys: [{ ...publicJwk, kid, alg, use: 'sig' }] },
  }
}

// ---------- client ----------

/**
 * Checks an agent card's signatures (section 8.4.3), and resolves `verified` or `unsigned`. Keys come from
 * `trustedKeys` (a key set's URL or file), or else from the signature's `jku`, which must be on the card's own
 * origin, over HTTPS unless it is loopback: a card cannot vouch for itself with a key from anywhere.
 */
export async function verifyCard(card, cardUrl, { fetch: fetchImpl = fetch, trustedKeys, requireSigned = false }) {
  if (!card.signatures?.length) {
    if (requireSigned) throw new Error('the agent card is not signed, and signed cards are required')
    return 'unsigned'
  }
  const sets = new Map()
  const keySet = source => {
    if (!sets.has(source)) {
      sets.set(
        source,
        /^https?:/.test(source)
          ? getJson(source, fetchImpl)
          : Promise.resolve(JSON.parse(readFileSync(source, 'utf8'))),
      )
    }
    return sets.get(source)
  }
  const agent = new URL(cardUrl)
  let reason // the SDK reports only that no signature verified; this keeps why a key was not found
  const publicKey = async (kid, jku) => {
    let source = trustedKeys
    if (!source) {
      const at = jku && new URL(jku, agent)
      if (!at || at.origin !== agent.origin || (at.protocol !== 'https:' && !isLoopback(at.hostname))) {
        throw new Error(`its key set ${jku ?? '(none named)'} is not on the agent's own origin; set trusted card keys`)
      }
      source = String(at)
    }
    const jwk = (await keySet(source)).keys?.find(k => k.kid === kid)
    if (!jwk) throw new Error(`no key "${kid}" in ${source}`)
    return jwk
  }
  try {
    await verifyAgentCardSignature((kid, jku) =>
      publicKey(kid, jku).catch(err => {
        reason = err.message
        throw err
      }),
    )(card)
  } catch (err) {
    throw new Error(`the agent card's signature does not verify: ${reason ?? err.message}`)
  }
  return 'verified'
}

const describeScheme = (name, scheme) => {
  const v = scheme?.value
  const what = {
    apiKeySecurityScheme: () => `API key in the ${v.name} ${v.location === 'query' ? 'query parameter' : v.location}`,
    httpAuthSecurityScheme: () => `HTTP ${v.scheme}`,
    oauth2SecurityScheme: () => `OAuth 2.0 ${v.flows?.flow?.$case ?? ''}`.trim(),
    openIdConnectSecurityScheme: () => 'OpenID Connect',
    mtlsSecurityScheme: () => 'mutual TLS: a client certificate',
  }[scheme?.$case]
  return `${name} (${what ? what() : 'a scheme this client does not know'})`
}

const basic = (user, password) =>
  `Basic ${Buffer.from(`${encodeURIComponent(user)}:${encodeURIComponent(password)}`).toString('base64')}`

// A request to a token or device authorization endpoint, with the client authenticated by HTTP Basic when it has a
// secret (RFC 6749 section 2.3.1), or naming itself in the body when it is a public client.
async function oauthPost(ctx, url, params) {
  const { clientId, clientSecret, audience } = ctx.credentials
  const body = new URLSearchParams(Object.entries(params).filter(([, v]) => v))
  if (audience) body.set('audience', audience)
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  if (clientSecret) headers.authorization = basic(clientId, clientSecret)
  else body.set('client_id', clientId)
  const res = await ctx.fetch(url, { method: 'POST', headers, body })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}
const tokenError = (url, { status, json }) =>
  new Error(`token endpoint ${url}: HTTP ${status} ${json.error ?? ''} ${json.error_description ?? ''}`.trim())
async function tokenGrant(ctx, url, params) {
  const r = await oauthPost(ctx, url, params)
  if (r.status !== 200 || !r.json.access_token) throw tokenError(url, r)
  return r.json
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The grants, each resolving the token endpoint's response.
const GRANTS = {
  client_credentials: (ctx, endpoints, scope) =>
    tokenGrant(ctx, endpoints.token, { grant_type: 'client_credentials', scope }),

  // RFC 8628: show the person a code and URL, then poll the token endpoint until they approve.
  async device_code(ctx, endpoints, scope) {
    const started = await oauthPost(ctx, endpoints.device, { scope })
    if (started.status !== 200) throw new Error(`device authorization ${endpoints.device}: HTTP ${started.status}`)
    const { device_code, user_code, verification_uri, verification_uri_complete, expires_in = 600 } = started.json
    let interval = (started.json.interval ?? 5) * 1000
    await ctx.onLogin({ url: verification_uri_complete ?? verification_uri, code: user_code })
    const deadline = Date.now() + expires_in * 1000
    while (Date.now() < deadline) {
      await sleep(interval)
      const r = await oauthPost(ctx, endpoints.token, { grant_type: DEVICE_GRANT, device_code })
      if (r.status === 200 && r.json.access_token) return r.json
      if (r.json.error === 'slow_down') interval += 5000
      else if (r.json.error !== 'authorization_pending') throw tokenError(endpoints.token, r)
    }
    throw new Error('the sign-in was not approved before its code expired')
  },

  // RFC 6749 section 4.1 with PKCE (RFC 7636) always, on a loopback redirect (RFC 8252 section 7.3).
  async authorization_code(ctx, endpoints, scope) {
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(16).toString('base64url')
    const listener = http.createServer()
    await new Promise((resolve, reject) =>
      listener.once('error', reject).listen(ctx.credentials.redirectPort ?? 0, '127.0.0.1', resolve),
    )
    const redirectUri = `http://127.0.0.1:${listener.address().port}/callback`
    try {
      const code = new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('the sign-in did not finish in time')), SIGN_IN_TIMEOUT_MS).unref()
        listener.on('request', (req, res) => {
          const p = new URL(req.url, redirectUri).searchParams
          if (!req.url.startsWith('/callback')) return res.writeHead(404).end()
          if (p.get('state') !== state) return res.writeHead(400).end('This sign-in was not started here.')
          if (p.get('error')) {
            res.writeHead(400).end(`Sign-in failed: ${p.get('error')}`)
            return reject(new Error(`sign-in failed: ${p.get('error')} ${p.get('error_description') ?? ''}`.trim()))
          }
          res.writeHead(200, { 'content-type': 'text/plain' }).end('Signed in. You can close this tab.')
          resolve(p.get('code'))
        })
      })
      const url = new URL(endpoints.authorization)
      for (const [k, v] of Object.entries({
        response_type: 'code',
        client_id: ctx.credentials.clientId,
        redirect_uri: redirectUri,
        scope,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        audience: ctx.credentials.audience,
      })) {
        if (v) url.searchParams.set(k, v)
      }
      await ctx.onLogin({ url: String(url) })
      return tokenGrant(ctx, endpoints.token, {
        grant_type: 'authorization_code',
        code: await code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      })
    } finally {
      listener.close()
    }
  },
}

// An access token for a grant: the cached one while it lasts, a refreshed one, or a new grant.
async function accessToken(ctx, grant, endpoints, scopes) {
  const { credentials: c, tokens } = ctx
  const scope = [...new Set([...scopes, ...(c.scope ? c.scope.split(' ') : [])])].join(' ')
  const key = JSON.stringify([endpoints.token, c.clientId, scope, c.audience ?? ''])
  const cached = tokens.get(key)
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken
  const refreshed =
    cached?.refreshToken &&
    (await tokenGrant(ctx, endpoints.refresh || endpoints.token, {
      grant_type: 'refresh_token',
      refresh_token: cached.refreshToken,
    }).catch(() => undefined))
  const json = refreshed ?? (await GRANTS[grant](ctx, endpoints, scope))
  tokens.set(key, {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? (refreshed && cached.refreshToken),
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  })
  return json.access_token
}

// How one scheme of a requirement is met, or null when the client holds nothing that meets it.
function meet(scheme, scopes, c) {
  const header = (name, value) => ({
    apply: r => {
      r.headers[name] = value
    },
  })
  const bearer = token => header('authorization', `Bearer ${token}`)
  // `resolve` finds the grant and its endpoints when the call is made.
  const oauth = (interactive, resolve) => ({
    interactive,
    apply: async (r, ctx) => {
      const { grant, ...endpoints } = await resolve(ctx)
      r.headers.authorization = `Bearer ${await accessToken(ctx, grant, endpoints, scopes)}`
    },
  })
  const v = scheme?.value
  switch (scheme?.$case) {
    case 'apiKeySecurityScheme': {
      if (!c.apiKey) return null
      if (v.location === 'header') return header(v.name.toLowerCase(), c.apiKey)
      if (v.location === 'cookie') {
        return {
          apply: r => {
            r.headers.cookie = [r.headers.cookie, `${v.name}=${c.apiKey}`].filter(Boolean).join('; ')
          },
        }
      }
      if (v.location === 'query') {
        return {
          apply: r => {
            r.query[v.name] = c.apiKey
          },
        }
      }
      return null
    }
    case 'httpAuthSecurityScheme':
      if (/^basic$/i.test(v.scheme))
        return c.username && c.password ? header('authorization', basic(c.username, c.password)) : null
      return c.token ? header('authorization', `${/^bearer$/i.test(v.scheme) ? 'Bearer' : v.scheme} ${c.token}`) : null
    case 'oauth2SecurityScheme': {
      if (c.token) return bearer(c.token)
      const flow = v.flows?.flow
      const grant = {
        clientCredentials: 'client_credentials',
        deviceCode: 'device_code',
        authorizationCode: 'authorization_code',
      }[flow?.$case]
      // Implicit and password are deprecated by the specification and dropped by OAuth 2.1.
      if (!grant || !c.clientId || (grant === 'client_credentials' && !c.clientSecret)) return null
      // The flow's own URLs first, then the authorization server's metadata (RFC 8414) for any it leaves out.
      return oauth(grant !== 'client_credentials', async ctx => {
        const f = flow.value
        const named = {
          grant,
          token: f.tokenUrl,
          refresh: f.refreshUrl,
          device: f.deviceAuthorizationUrl,
          authorization: f.authorizationUrl,
        }
        const needed = {
          client_credentials: ['token'],
          device_code: ['token', 'device'],
          authorization_code: ['token', 'authorization'],
        }[grant]
        if (needed.every(k => named[k]) || !v.oauth2MetadataUrl) return named
        const m = await getJson(v.oauth2MetadataUrl, ctx.fetch)
        return {
          grant,
          token: named.token || m.token_endpoint,
          refresh: named.refresh,
          device: named.device || m.device_authorization_endpoint,
          authorization: named.authorization || m.authorization_endpoint,
        }
      })
    }
    case 'openIdConnectSecurityScheme': {
      if (c.token) return bearer(c.token)
      if (!c.clientId) return null
      // A confidential client signs itself in; a public one asks a person, on a device page or in the browser.
      return oauth(!c.clientSecret, async ctx => {
        const m = await getJson(v.openIdConnectUrl, ctx.fetch)
        return {
          grant: c.clientSecret
            ? 'client_credentials'
            : m.device_authorization_endpoint
              ? 'device_code'
              : 'authorization_code',
          token: m.token_endpoint,
          device: m.device_authorization_endpoint,
          authorization: m.authorization_endpoint,
        }
      })
    }
    case 'mtlsSecurityScheme':
      return c.clientCertificate ? { apply: () => {} } : null
    default:
      return null
  }
}

/**
 * The credentials a call carries, from the card's security requirements (any one of them, every scheme within it)
 * and what the client holds: `{ headers, query }`. A card with no requirements but schemes takes any one scheme;
 * a card with neither gets nothing, so a token never reaches an agent that did not ask for it.
 *
 * `credentials`: apiKey, token, username, password, clientId, clientSecret, scope, audience, redirectPort,
 * clientCertificate (whether the transport presents one). `tokens` caches access tokens ({ get, set }); `onLogin`
 * shows a person `{ url, code? }` to sign in. With `interactive: false`, requirements that need a person are skipped.
 */
export async function clientAuth(card, credentials, { fetch: fetchImpl = fetch, tokens, onLogin, interactive = true }) {
  const schemes = Object.fromEntries(Object.entries(card.securitySchemes ?? {}).map(([n, s]) => [n, s.scheme]))
  const requirements = card.securityRequirements?.length
    ? card.securityRequirements.map(r =>
        Object.entries(r.schemes ?? {}).map(([name, s]) => ({ name, scopes: s?.list ?? [] })),
      )
    : Object.keys(schemes).map(name => [{ name, scopes: [] }])
  const result = { headers: {}, query: {} }
  if (!requirements.length) return result

  const ways = requirements
    .map(requirement => requirement.map(({ name, scopes }) => meet(schemes[name], scopes, credentials)))
    .filter(steps => steps.every(Boolean) && (interactive || !steps.some(s => s.interactive)))
  const chosen = ways.find(steps => !steps.some(s => s.interactive)) ?? ways[0]
  if (!chosen) {
    const asks = requirements.map(r => r.map(({ name }) => describeScheme(name, schemes[name])).join(' and '))
    throw new Error(`the agent asks for ${asks.join(', or ')}; none of them is configured on this client`)
  }
  const ctx = { fetch: fetchImpl, tokens, onLogin, credentials }
  for (const step of chosen) await step.apply(result, ctx)
  return result
}
