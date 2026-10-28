// What the bridge's tests share: free ports, a stand-in OAuth 2.0 / OpenID Connect provider, and test certificates.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

import { exportJWK, generateKeyPair, SignJWT } from 'jose'

export const freePort = () =>
  new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const json = (res, status, body) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
const base64url = buffer => Buffer.from(buffer).toString('base64url')

/**
 * A stand-in authorization server. `oidc: true` serves OpenID Connect discovery, `false` only RFC 8414 OAuth 2.0
 * metadata. It knows two clients: `client:secret` (confidential) and `public` (no secret), and serves every grant
 * the bridge uses: client credentials, device code (RFC 8628), authorization code with PKCE (RFC 7636) and refresh.
 * The device and browser steps are taken by fetching the URL the bridge shows, as a person would open it.
 */
export async function authServer({ oidc = true } = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const port = await freePort()
  const issuer = `http://127.0.0.1:${port}`
  const sign = ({ aud = 'a2a-test', exp = '5m', key = privateKey, alg = 'RS256', iss = issuer, scope } = {}) =>
    new SignJWT({ sub: 'agent-x', ...(scope && { scope }) })
      .setProtectedHeader({ alg, kid: 'k1' })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(key)

  const grants = []
  const devices = new Map() // device_code -> { userCode, approved, scope }
  const codes = new Map() // code -> { challenge, redirectUri, scope }
  const refreshTokens = new Map() // refresh token -> scope
  const metadata = {
    issuer,
    jwks_uri: `${issuer}/jwks`,
    token_endpoint: `${issuer}/token`,
    authorization_endpoint: `${issuer}/authorize`,
    device_authorization_endpoint: `${issuer}/device`,
    grant_types_supported: ['client_credentials', 'authorization_code', 'urn:ietf:params:oauth:grant-type:device_code'],
  }
  const tokens = async scope => {
    const refresh = randomUUID()
    refreshTokens.set(refresh, scope)
    return { access_token: await sign({ scope }), token_type: 'Bearer', expires_in: 300, refresh_token: refresh }
  }
  const form = req =>
    new Promise(resolve => {
      let body = ''
      req.on('data', d => (body += d))
      req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))))
    })
  const confidential = req => req.headers.authorization === `Basic ${Buffer.from('client:secret').toString('base64')}`

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer)
    if (url.pathname === '/.well-known/openid-configuration')
      return oidc ? json(res, 200, metadata) : json(res, 404, {})
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(res, 200, metadata)
    if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] })
    if (url.pathname === '/device' && req.method === 'POST') {
      const body = await form(req)
      if (body.client_id !== 'public') return json(res, 401, { error: 'invalid_client' })
      const deviceCode = randomUUID()
      const userCode = 'WDJB-MJHT'
      devices.set(deviceCode, { userCode, approved: false, scope: body.scope })
      return json(res, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${issuer}/activate`,
        verification_uri_complete: `${issuer}/activate?user_code=${userCode}`,
        expires_in: 60,
        interval: 1,
      })
    }
    if (url.pathname === '/activate') {
      for (const device of devices.values())
        if (device.userCode === url.searchParams.get('user_code')) device.approved = true
      return res.writeHead(200).end('approved')
    }
    if (url.pathname === '/authorize') {
      const p = url.searchParams
      if (p.get('client_id') !== 'public' || p.get('code_challenge_method') !== 'S256') {
        return res.writeHead(400).end('bad request')
      }
      const code = randomUUID()
      codes.set(code, { challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri'), scope: p.get('scope') })
      const back = new URL(p.get('redirect_uri'))
      back.searchParams.set('code', code)
      back.searchParams.set('state', p.get('state'))
      return res.writeHead(302, { location: String(back) }).end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const body = await form(req)
      grants.push(body.grant_type)
      if (body.grant_type === 'client_credentials') {
        if (!confidential(req)) return json(res, 401, { error: 'invalid_client' })
        return json(res, 200, await tokens(body.scope))
      }
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const device = devices.get(body.device_code)
        if (!device || body.client_id !== 'public') return json(res, 400, { error: 'invalid_grant' })
        if (!device.approved) return json(res, 400, { error: 'authorization_pending' })
        devices.delete(body.device_code)
        return json(res, 200, await tokens(device.scope))
      }
      if (body.grant_type === 'authorization_code') {
        const code = codes.get(body.code)
        codes.delete(body.code)
        const challenge = body.code_verifier && base64url(createHash('sha256').update(body.code_verifier).digest())
        if (!code || code.challenge !== challenge || code.redirectUri !== body.redirect_uri) {
          return json(res, 400, { error: 'invalid_grant' })
        }
        return json(res, 200, await tokens(code.scope))
      }
      if (body.grant_type === 'refresh_token') {
        if (!refreshTokens.has(body.refresh_token)) return json(res, 400, { error: 'invalid_grant' })
        const scope = refreshTokens.get(body.refresh_token)
        refreshTokens.delete(body.refresh_token)
        return json(res, 200, await tokens(scope))
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    json(res, 404, {})
  })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  after(() => server.close())
  return { issuer, sign, grants }
}

/**
 * A test certificate authority, a server certificate for 127.0.0.1 and a client certificate (CN=agent-y), as PEM
 * file paths. Made with the openssl command line, as Node has no certificate generator.
 */
export function certificates() {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-certs-'))
  const at = name => join(dir, name)
  const openssl = (...args) => execFileSync('openssl', args, { stdio: 'pipe' })
  writeFileSync(at('ec.pem'), openssl('ecparam', '-name', 'prime256v1'))
  openssl(
    ...['req', '-x509', '-newkey', `ec:${at('ec.pem')}`, '-nodes', '-days', '1', '-subj', '/CN=a2a test CA'],
    ...['-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign'],
    ...['-keyout', at('ca.key'), '-out', at('ca.pem')],
  )
  const issue = (name, subject, extension) => {
    openssl(
      'req',
      '-newkey',
      `ec:${at('ec.pem')}`,
      '-nodes',
      '-subj',
      subject,
      '-keyout',
      at(`${name}.key`),
      '-out',
      at(`${name}.csr`),
    )
    writeFileSync(at(`${name}.ext`), extension)
    openssl(
      ...['x509', '-req', '-in', at(`${name}.csr`), '-CA', at('ca.pem'), '-CAkey', at('ca.key'), '-CAcreateserial'],
      ...['-days', '1', '-extfile', at(`${name}.ext`), '-out', at(`${name}.pem`)],
    )
  }
  issue('server', '/CN=127.0.0.1', 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n')
  issue('client', '/CN=agent-y', 'extendedKeyUsage=clientAuth\n')
  return {
    ca: at('ca.pem'),
    serverCert: at('server.pem'),
    serverKey: at('server.key'),
    clientCert: at('client.pem'),
    clientKey: at('client.key'),
  }
}
