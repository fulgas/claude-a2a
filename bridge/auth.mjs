// Authentication for both sides of the bridge.
//
// Server: an API key in the X-API-Key header, an OIDC-issued JWT as a bearer token, or both (either one passes).
// Client: reads the remote agent's card and sends what it asks for: the API key in the header its scheme names,
// and a bearer token given directly or fetched with the OAuth2 client-credentials grant.
import { timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, errors, jwtVerify } from 'jose'

export const API_KEY_HEADER = 'X-API-Key'
// Asymmetric algorithms only: a key set from the issuer never verifies an HMAC token signed with a public key.
const JWT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']

const sameSecret = (a, b) => {
  const [x, y] = [Buffer.from(String(a)), Buffer.from(String(b))]
  return x.length === y.length && timingSafeEqual(x, y)
}

async function discover(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`OIDC discovery ${url}: HTTP ${res.status}`)
  return res.json()
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

/**
 * The server's authenticator. With neither an API key nor an issuer, every request passes as `anonymous`.
 * `authenticate(headers)` resolves the caller's name, or null when the request must be refused.
 */
export async function serverAuth({ apiKey, issuer, audience }) {
  if (issuer && !audience)
    throw new Error('--oidc-issuer needs --oidc-audience: a JWT for another service must not pass')

  let verifyJwt
  const securitySchemes = {}
  const securityRequirements = []
  if (apiKey) {
    securitySchemes.apiKey = { apiKeySecurityScheme: { location: 'header', name: API_KEY_HEADER } }
    securityRequirements.push({ schemes: { apiKey: { list: [] } } })
  }
  if (issuer) {
    const discoveryUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
    const config = await discover(discoveryUrl)
    if (config.issuer !== issuer) {
      throw new Error(`OIDC issuer mismatch: ${discoveryUrl} names "${config.issuer}", not "${issuer}"`)
    }
    const keys = createRemoteJWKSet(new URL(config.jwks_uri))
    verifyJwt = token => jwtVerify(token, keys, { issuer, audience, algorithms: JWT_ALGORITHMS, clockTolerance: 30 })
    securitySchemes.oidc = { openIdConnectSecurityScheme: { openIdConnectUrl: discoveryUrl } }
    securityRequirements.push({ schemes: { oidc: { list: [] } } })
  }

  async function authenticate(headers) {
    if (!apiKey && !verifyJwt) return 'anonymous'
    const key = headers[API_KEY_HEADER.toLowerCase()]
    if (apiKey && key && sameSecret(key, apiKey)) return 'api-key'
    const bearer = /^Bearer (.+)$/i.exec(headers.authorization ?? '')?.[1]
    if (verifyJwt && bearer) {
      try {
        const { payload } = await verifyJwt(bearer)
        return payload.sub ? `oidc:${payload.sub}` : 'oidc'
      } catch (err) {
        if (err instanceof errors.JOSEError) return null
        throw err
      }
    }
    return null
  }

  return { authenticate, securitySchemes, securityRequirements, isConfigured: Boolean(apiKey || verifyJwt) }
}

async function clientCredentialsToken(card, { clientId, clientSecret, scope, audience }) {
  const schemes = Object.values(card.securitySchemes ?? {}).map(s => s.scheme)
  const flow = schemes.find(s => s?.$case === 'oauth2SecurityScheme')?.value.flows?.flow
  let tokenUrl = flow?.$case === 'clientCredentials' ? flow.value.tokenUrl : undefined
  if (!tokenUrl) {
    const oidc = schemes.find(s => s?.$case === 'openIdConnectSecurityScheme')?.value.openIdConnectUrl
    if (oidc) tokenUrl = (await discover(oidc)).token_endpoint
  }
  if (!tokenUrl) throw new Error('the agent card names no OAuth2 client-credentials or OIDC token endpoint')

  const body = new URLSearchParams({ grant_type: 'client_credentials' })
  if (scope) body.set('scope', scope)
  if (audience) body.set('audience', audience)
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`,
    },
    body,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.access_token) {
    throw new Error(`token endpoint ${tokenUrl}: HTTP ${res.status} ${json.error ?? ''}`.trim())
  }
  return json.access_token
}

/**
 * The headers a client call carries, from the card's security schemes and what it was given:
 * an API key goes in the header the card's apiKey scheme names; a bearer token is given, or fetched with
 * the client-credentials grant when a client id and secret are set.
 */
export async function clientHeaders(card, { apiKey, token, clientId, clientSecret, scope, audience }) {
  const headers = {}
  const apiKeyScheme = Object.values(card.securitySchemes ?? {})
    .map(s => s.scheme)
    .find(s => s?.$case === 'apiKeySecurityScheme')?.value
  if (apiKey) {
    if (apiKeyScheme && apiKeyScheme.location !== 'header') {
      throw new Error(`the agent wants its API key in the ${apiKeyScheme.location}; only a header is supported`)
    }
    headers[(apiKeyScheme?.name ?? API_KEY_HEADER).toLowerCase()] = apiKey
  }
  const bearer =
    token ??
    (clientId && clientSecret
      ? await clientCredentialsToken(card, { clientId, clientSecret, scope, audience })
      : undefined)
  if (bearer) headers.authorization = `Bearer ${bearer}`
  return Object.keys(headers).length ? headers : undefined
}
