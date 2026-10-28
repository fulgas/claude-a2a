// The client side of authentication: from what an agent card asks for and what the client holds, the credentials a
// call carries. Interactive grants are completed by fetching the URL the client shows, as a person would open it.
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { AgentCard } from '@a2a-js/sdk'

import { cardSigner, clientAuth, verifyCard } from './auth.mjs'
import { authServer } from './test-support.mjs'

const card = (securitySchemes, securityRequirements) => AgentCard.fromJSON({ securitySchemes, securityRequirements })
const only = (...names) => names.map(name => ({ schemes: { [name]: { list: [] } } }))
const apiKey = (location, name = 'X-API-Key') => ({ apiKeySecurityScheme: { location, name } })

// A token cache as the plugin keeps one between calls.
const cache = () => {
  const map = new Map()
  return { get: key => map.get(key), set: (key, value) => map.set(key, value), map }
}
// Opens what the client shows, as the person would: the device page, or the authorization URL whose redirect the
// client's loopback listener receives.
const person = async ({ url }) => {
  const res = await fetch(url, { redirect: 'manual' })
  if (res.status === 302) await fetch(res.headers.get('location'))
}
const auth = (c, credentials, options = {}) =>
  clientAuth(c, credentials, { fetch, tokens: cache(), onLogin: person, ...options })

describe('which credentials a call carries', () => {
  test('nothing to an agent whose card asks for nothing, whatever the client holds', async () => {
    const r = await auth(card({}, []), { token: 't0ken', apiKey: 'k3y', clientId: 'client', clientSecret: 'secret' })
    assert.deepEqual(r, { headers: {}, query: {} })
  })

  test('an API key in the header, cookie or query parameter the card names', async () => {
    for (const [location, expected] of [
      ['header', { headers: { 'x-api-key': 'k3y' }, query: {} }],
      ['cookie', { headers: { cookie: 'X-API-Key=k3y' }, query: {} }],
      ['query', { headers: {}, query: { 'X-API-Key': 'k3y' } }],
    ]) {
      assert.deepEqual(await auth(card({ key: apiKey(location) }, only('key')), { apiKey: 'k3y' }), expected)
    }
  })

  test('HTTP Bearer and Basic', async () => {
    const bearer = card({ http: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'JWT' } } }, only('http'))
    assert.deepEqual((await auth(bearer, { token: 't0ken' })).headers, { authorization: 'Bearer t0ken' })
    const basic = card({ http: { httpAuthSecurityScheme: { scheme: 'basic' } } }, only('http'))
    assert.deepEqual((await auth(basic, { username: 'ann', password: 'pw' })).headers, {
      authorization: `Basic ${Buffer.from('ann:pw').toString('base64')}`,
    })
  })

  test('every scheme of one requirement, or the next requirement the client can meet', async () => {
    const schemes = { key: apiKey('header'), http: { httpAuthSecurityScheme: { scheme: 'Bearer' } } }
    const both = [{ schemes: { key: { list: [] }, http: { list: [] } } }]
    assert.deepEqual((await auth(card(schemes, both), { apiKey: 'k3y', token: 't' })).headers, {
      'x-api-key': 'k3y',
      authorization: 'Bearer t',
    })
    const eitherOr = [...both, ...only('http')]
    assert.deepEqual((await auth(card(schemes, eitherOr), { token: 't' })).headers, { authorization: 'Bearer t' })
  })

  test('schemes with no requirements are each enough on their own', async () => {
    assert.deepEqual((await auth(card({ key: apiKey('header') }, []), { apiKey: 'k3y' })).headers, {
      'x-api-key': 'k3y',
    })
  })

  test('mutual TLS is met by a client certificate alone', async () => {
    const mtls = card({ mtls: { mtlsSecurityScheme: {} } }, only('mtls'))
    assert.deepEqual(await auth(mtls, { clientCertificate: true }), { headers: {}, query: {} })
    await assert.rejects(auth(mtls, {}), /mtls.*client certificate/)
  })

  test('a card asking for what the client does not hold is an error naming what it asks for', async () => {
    const c = card(
      { key: apiKey('header'), oidc: { openIdConnectSecurityScheme: { openIdConnectUrl: 'x' } } },
      only('key', 'oidc'),
    )
    await assert.rejects(auth(c, {}), /key \(API key in the X-API-Key header\).*oidc \(OpenID Connect\)/s)
  })
})

describe('OAuth 2.0 and OpenID Connect', async () => {
  const provider = await authServer()
  const oauth2 = (flow, extra = {}) => ({ oauth2SecurityScheme: { flows: flow, ...extra } })
  const confidential = { clientId: 'client', clientSecret: 'secret' }

  test('a given token meets any OAuth 2.0 scheme', async () => {
    const c = card({ o: oauth2({ clientCredentials: { tokenUrl: `${provider.issuer}/token` } }) }, only('o'))
    assert.deepEqual((await auth(c, { token: 't' })).headers, { authorization: 'Bearer t' })
  })

  test("client credentials at the flow's token URL, asking for the requirement's scopes", async () => {
    const c = card({ o: oauth2({ clientCredentials: { tokenUrl: `${provider.issuer}/token` } }) }, [
      { schemes: { o: { list: ['a2a.tasks', 'a2a.read'] } } },
    ])
    const { authorization } = (await auth(c, confidential)).headers
    const { scope } = JSON.parse(Buffer.from(authorization.split('.')[1], 'base64url'))
    assert.equal(scope, 'a2a.tasks a2a.read')
  })

  test('the token URL from the oauth2MetadataUrl (RFC 8414) when the flow names none', async () => {
    const c = card(
      {
        o: oauth2(
          { clientCredentials: {} },
          { oauth2MetadataUrl: `${provider.issuer}/.well-known/oauth-authorization-server` },
        ),
      },
      only('o'),
    )
    assert.match((await auth(c, confidential)).headers.authorization, /^Bearer ey/)
  })

  test('a wrong client secret is an error from the token endpoint', async () => {
    const c = card({ o: oauth2({ clientCredentials: { tokenUrl: `${provider.issuer}/token` } }) }, only('o'))
    await assert.rejects(auth(c, { clientId: 'client', clientSecret: 'nope' }), /token endpoint .*401 invalid_client/)
  })

  test('the device code flow (RFC 8628) shows the code and URL, then waits for approval', async () => {
    const c = card(
      {
        o: oauth2({
          deviceCode: { deviceAuthorizationUrl: `${provider.issuer}/device`, tokenUrl: `${provider.issuer}/token` },
        }),
      },
      only('o'),
    )
    const shown = []
    const r = await auth(c, { clientId: 'public' }, { onLogin: login => shown.push(login) && person(login) })
    assert.match(r.headers.authorization, /^Bearer ey/)
    assert.deepEqual(shown, [{ url: `${provider.issuer}/activate?user_code=WDJB-MJHT`, code: 'WDJB-MJHT' }])
  })

  test('the authorization code flow with PKCE (RFC 7636) on a loopback redirect (RFC 8252)', async () => {
    const c = card(
      {
        o: oauth2({
          authorizationCode: {
            authorizationUrl: `${provider.issuer}/authorize`,
            tokenUrl: `${provider.issuer}/token`,
            pkceRequired: true,
          },
        }),
      },
      only('o'),
    )
    assert.match((await auth(c, { clientId: 'public' })).headers.authorization, /^Bearer ey/)
  })

  test('OpenID Connect: client credentials with a secret, the device flow without one', async () => {
    const c = card(
      {
        oidc: {
          openIdConnectSecurityScheme: { openIdConnectUrl: `${provider.issuer}/.well-known/openid-configuration` },
        },
      },
      only('oidc'),
    )
    provider.grants.length = 0
    await auth(c, confidential)
    await auth(c, { clientId: 'public' })
    assert.equal(provider.grants[0], 'client_credentials')
    assert.equal(provider.grants.at(-1), 'urn:ietf:params:oauth:grant-type:device_code')
  })

  test('a requirement met without a person is preferred to one that needs a sign-in', async () => {
    const c = card(
      {
        device: oauth2({
          deviceCode: { deviceAuthorizationUrl: `${provider.issuer}/device`, tokenUrl: `${provider.issuer}/token` },
        }),
        key: apiKey('header'),
      },
      only('device', 'key'),
    )
    const r = await auth(
      c,
      { clientId: 'public', apiKey: 'k3y' },
      { onLogin: () => assert.fail('asked for a sign-in') },
    )
    assert.deepEqual(r.headers, { 'x-api-key': 'k3y' })
  })

  test('a cached token is reused, and an expired one is refreshed', async () => {
    const c = card({ o: oauth2({ clientCredentials: { tokenUrl: `${provider.issuer}/token` } }) }, only('o'))
    const tokens = cache()
    provider.grants.length = 0
    const first = await auth(c, confidential, { tokens })
    assert.deepEqual(await auth(c, confidential, { tokens }), first)
    assert.deepEqual(provider.grants, ['client_credentials'])

    const [key] = tokens.map.keys()
    tokens.set(key, { ...tokens.get(key), expiresAt: Date.now() - 1000 })
    await auth(c, confidential, { tokens })
    assert.deepEqual(provider.grants, ['client_credentials', 'refresh_token'])
  })
})

describe('agent card signatures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-sign-'))
  const keyFile = join(dir, 'card.key')
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const agentUrl = 'https://agent.example.test/'
  const jku = 'https://agent.example.test/.well-known/jwks.json'
  const signer = await cardSigner(keyFile, jku)
  const signed = await signer.sign(AgentCard.fromJSON({ name: 'signed agent', version: '1.0.0' }))
  // A fetch that serves the agent's key set and nothing else.
  const served = jwks => async url =>
    String(url) === jku ? new Response(JSON.stringify(jwks)) : new Response('', { status: 404 })

  test('a card signed with ES256 verifies against the key set on its own origin', async () => {
    assert.equal(
      signed.signatures[0].protected && JSON.parse(Buffer.from(signed.signatures[0].protected, 'base64url')).alg,
      'ES256',
    )
    assert.equal(await verifyCard(signed, agentUrl, { fetch: served(signer.jwks) }), 'verified')
  })

  test('a changed card does not verify', async () => {
    const changed = AgentCard.fromJSON({ ...AgentCard.toJSON(signed), name: 'someone else' })
    await assert.rejects(verifyCard(changed, agentUrl, { fetch: served(signer.jwks) }), /does not verify/)
  })

  test("a key set on another origin is not trusted, unless it is the client's trusted keys", async () => {
    await assert.rejects(
      verifyCard(signed, 'https://elsewhere.test/', { fetch: served(signer.jwks) }),
      /not on the agent's own origin/,
    )
    const trusted = join(dir, 'trusted.json')
    writeFileSync(trusted, JSON.stringify(signer.jwks))
    assert.equal(await verifyCard(signed, 'https://elsewhere.test/', { trustedKeys: trusted }), 'verified')
  })

  test('an unsigned card passes as unsigned, unless signed cards are required', async () => {
    const unsigned = AgentCard.fromJSON({ name: 'plain' })
    assert.equal(await verifyCard(unsigned, agentUrl, {}), 'unsigned')
    await assert.rejects(verifyCard(unsigned, agentUrl, { requireSigned: true }), /not signed/)
  })
})
