// End-to-end tests of the shipped bridge (dist/a2a.mjs): a real server, real clients,
// and this file playing the plugin's part of answering tasks over the control socket.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { after, describe, test } from 'node:test'
import { promisify } from 'node:util'

import { exportJWK, generateKeyPair, SignJWT } from 'jose'

const BRIDGE = new URL('../dist/a2a.mjs', import.meta.url).pathname
const run = promisify(execFile)

const freePort = () =>
  new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

// Runs a client command with no credentials from the environment but `env`; returns its last NDJSON line.
const NO_CREDENTIALS = { A2A_TOKEN: '', A2A_API_KEY: '', A2A_OAUTH_CLIENT_ID: '', A2A_OAUTH_CLIENT_SECRET: '' }
async function clientWith(env, ...args) {
  const options = { env: { ...process.env, ...NO_CREDENTIALS, ...env } }
  const { stdout } = await run('node', [BRIDGE, ...args], options).catch(e => e)
  return JSON.parse(stdout.trim().split('\n').at(-1))
}
const client = (...args) => clientWith({}, ...args)

// Starts `serve` and answers every task with "echo: <text>", as the plugin would; a leading
// `{ replyAfterMs }` holds each answer back, to keep tasks running.
async function serve(...args) {
  const { replyAfterMs = 0 } = typeof args[0] === 'object' ? args.shift() : {}
  const [port, grpcPort] = [await freePort(), await freePort()]
  const control = `/tmp/a2a-test-${randomUUID().slice(0, 8)}.sock`
  const child = spawn('node', [BRIDGE, 'serve', '--control', control, '--port', port, '--grpc-port', grpcPort, ...args])
  after(() => child.kill())

  let buffered = ''
  const callers = []
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      buffered += chunk
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const msg = JSON.parse(buffered.slice(0, at))
        buffered = buffered.slice(at + 1)
        if (msg.type === 'ready') resolve(msg)
        if (msg.type === 'error') reject(new Error(msg.error))
        if (msg.type === 'task') {
          callers.push(msg.caller)
          setTimeout(
            () =>
              http
                .request({ socketPath: control, path: '/reply', method: 'POST' }, res => res.resume())
                .end(JSON.stringify({ taskId: msg.taskId, ok: true, text: `echo: ${msg.text}` })),
            replyAfterMs,
          )
        }
      }
    })
  })
  return { url: `http://127.0.0.1:${port}`, ready: await ready, callers }
}

// A stand-in OIDC provider: discovery, a key set, and a client-credentials token endpoint for client:secret.
async function oidcProvider() {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const port = await freePort()
  const issuer = `http://127.0.0.1:${port}`
  const sign = ({ aud = 'a2a-test', exp = '5m', key = privateKey, alg = 'RS256', iss = issuer } = {}) =>
    new SignJWT({ sub: 'agent-x' })
      .setProtectedHeader({ alg, kid: 'k1' })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(key)
  const json = (res, status, body) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  const server = http.createServer(async (req, res) => {
    if (req.url === '/.well-known/openid-configuration') {
      return json(res, 200, { issuer, jwks_uri: `${issuer}/jwks`, token_endpoint: `${issuer}/token` })
    }
    if (req.url === '/jwks') return json(res, 200, { keys: [jwk] })
    if (req.url === '/token' && req.method === 'POST') {
      const good = `Basic ${Buffer.from('client:secret').toString('base64')}`
      if (req.headers.authorization !== good) return json(res, 401, { error: 'invalid_client' })
      return json(res, 200, { access_token: await sign(), token_type: 'Bearer', expires_in: 300 })
    }
    json(res, 404, {})
  })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  after(() => server.close())
  return { issuer, sign }
}

describe('transports all', async () => {
  const { url, ready } = await serve()

  test('ready names every endpoint', () => {
    assert.ok(ready.jsonrpc && ready.rest && ready.grpc)
  })

  for (const transport of ['jsonrpc', 'rest', 'grpc']) {
    test(`send over ${transport} completes with the answer as an artifact`, async () => {
      const r = await client('send', url, `hi ${transport}`, '--transport', transport)
      assert.equal(r.type, 'result')
      assert.equal(r.state, 'completed')
      assert.deepEqual(r.artifacts, [{ name: 'answer', text: `echo: hi ${transport}` }])
    })
  }

  test('get returns a finished task over gRPC', async () => {
    const sent = await client('send', url, 'remember me')
    const got = await client('get', url, sent.taskId, '--transport', 'grpc')
    assert.equal(got.state, 'completed')
    assert.equal(got.artifacts[0].text, 'echo: remember me')
  })
})

describe('transports http', async () => {
  const { url, ready } = await serve('--transports', 'http')

  test('the card lists no gRPC interface', async () => {
    assert.equal(ready.grpc, undefined)
    const { card } = await client('card', url)
    assert.deepEqual(
      card.supportedInterfaces.map(i => i.protocolBinding),
      ['JSONRPC', 'HTTP+JSON'],
    )
  })

  test('gRPC is refused, JSON-RPC works', async () => {
    assert.equal((await client('send', url, 'x', '--transport', 'grpc')).type, 'error')
    assert.equal((await client('send', url, 'x', '--transport', 'jsonrpc')).state, 'completed')
  })
})

describe('transports grpc', async () => {
  const { url, ready } = await serve('--transports', 'grpc')

  test('the HTTP port serves only the card, which lists gRPC alone', async () => {
    assert.equal(ready.jsonrpc, undefined)
    const { card } = await client('card', url)
    assert.deepEqual(
      card.supportedInterfaces.map(i => i.protocolBinding),
      ['GRPC'],
    )
    const res = await fetch(`${url}/a2a/jsonrpc`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 404)
  })

  test('send over gRPC completes', async () => {
    assert.equal((await client('send', url, 'x', '--transport', 'grpc')).state, 'completed')
  })
})

describe('api key', async () => {
  const { url, callers } = await serve('--api-key', 'k3y')

  test('the card asks for it in the X-API-Key header', async () => {
    const { card } = await client('card', url)
    assert.deepEqual(card.securitySchemes, {
      apiKey: { apiKeySecurityScheme: { location: 'header', name: 'X-API-Key' } },
    })
  })

  for (const transport of ['jsonrpc', 'rest', 'grpc']) {
    test(`${transport} refuses a call without the key or with a wrong one, and takes the right one`, async () => {
      assert.match((await client('send', url, 'x', '--transport', transport)).error, /401|unauthorized/i)
      assert.match(
        (await client('send', url, 'x', '--transport', transport, '--api-key', 'nope')).error,
        /401|unauthorized/i,
      )
      const r = await clientWith({ A2A_API_KEY: 'k3y' }, 'send', url, 'x', '--transport', transport)
      assert.equal(r.state, 'completed')
      assert.equal(callers.at(-1), 'api-key')
    })
  }

  for (const transport of ['jsonrpc', 'grpc']) {
    test(`${transport} refuses a client that keeps guessing, even with the right key`, async () => {
      const guessed = await serve('--api-key', 'k3y')
      const guesses = Array.from({ length: 20 }, (_, i) =>
        client('send', guessed.url, 'x', '--transport', transport, '--api-key', `guess-${i}`),
      )
      await Promise.all(guesses)
      const r = await client('send', guessed.url, 'x', '--transport', transport, '--api-key', 'k3y')
      assert.match(r.error, /429 Too Many Requests|too many failed attempts/)
    })
  }

  test('a non-loopback host with no API key and no OIDC issuer is refused', async () => {
    const r = await client('serve', '--control', '/tmp/a2a-unused.sock', '--host', '0.0.0.0')
    assert.match(r.error, /refusing to listen/)
  })
})

describe('oidc', async () => {
  const provider = await oidcProvider()
  const { url, callers } = await serve('--oidc-issuer', provider.issuer, '--oidc-audience', 'a2a-test')

  test('the card names the OIDC discovery document', async () => {
    const { card } = await client('card', url)
    assert.equal(
      card.securitySchemes.oidc.openIdConnectSecurityScheme.openIdConnectUrl,
      `${provider.issuer}/.well-known/openid-configuration`,
    )
  })

  for (const transport of ['jsonrpc', 'rest', 'grpc']) {
    test(`${transport} takes a valid JWT and names its subject as the caller`, async () => {
      assert.match((await client('send', url, 'x', '--transport', transport)).error, /401|unauthorized/i)
      const r = await client('send', url, 'x', '--transport', transport, '--token', await provider.sign())
      assert.equal(r.state, 'completed')
      assert.equal(callers.at(-1), 'oidc:agent-x')
    })
  }

  test('a JWT for another audience, an expired one, one from another issuer and an HMAC one are refused', async () => {
    const expired = Math.floor(Date.now() / 1000) - 3600
    const hmac = new TextEncoder().encode('a-shared-secret-of-at-least-32-bytes!')
    for (const token of [
      await provider.sign({ aud: 'someone-else' }),
      await provider.sign({ exp: expired }),
      await provider.sign({ iss: 'https://evil.test' }),
      await provider.sign({ key: hmac, alg: 'HS256' }),
    ]) {
      assert.match((await client('send', url, 'x', '--token', token)).error, /401|unauthorized/i)
    }
  })

  test('the client fetches a token with the client-credentials grant', async () => {
    const ok = await clientWith({ A2A_OAUTH_CLIENT_ID: 'client', A2A_OAUTH_CLIENT_SECRET: 'secret' }, 'send', url, 'x')
    assert.equal(ok.state, 'completed')
    const bad = await clientWith({ A2A_OAUTH_CLIENT_ID: 'client', A2A_OAUTH_CLIENT_SECRET: 'wrong' }, 'send', url, 'x')
    assert.match(bad.error, /token endpoint .*401 invalid_client/)
  })

  test('an issuer without an audience is refused at startup', async () => {
    const r = await client('serve', '--control', '/tmp/a2a-unused.sock', '--oidc-issuer', provider.issuer)
    assert.match(r.error, /needs --oidc-audience/)
  })
})

describe('api key and oidc together', async () => {
  const provider = await oidcProvider()
  const { url } = await serve('--api-key', 'k3y', '--oidc-issuer', provider.issuer, '--oidc-audience', 'a2a-test')

  test('either credential passes', async () => {
    assert.equal((await client('send', url, 'x', '--api-key', 'k3y')).state, 'completed')
    assert.equal((await client('send', url, 'x', '--token', await provider.sign())).state, 'completed')
    assert.match((await client('send', url, 'x')).error, /401|unauthorized/i)
  })
})

describe('task limits', async () => {
  test('a caller over its tasks a minute gets a failed task, before any subagent starts', async () => {
    const { url, callers } = await serve('--tasks-per-minute', '2')
    for (const n of [1, 2]) assert.equal((await client('send', url, `task ${n}`)).state, 'completed')
    const over = await client('send', url, 'task 3')
    assert.equal(over.state, 'failed')
    assert.match(over.status, /rate limit/)
    assert.equal(callers.length, 2)
  })

  test('a task over the concurrent limit fails as busy while the others run', async () => {
    const { url } = await serve({ replyAfterMs: 1500 }, '--max-concurrent-tasks', '1')
    const [a, b] = await Promise.all([client('send', url, 'first'), client('send', url, 'second')])
    const states = [a.state, b.state].sort()
    assert.deepEqual(states, ['completed', 'failed'])
    assert.match([a, b].find(r => r.state === 'failed').status, /busy/)
  })

  test('the failed sign-in limit is configurable', async () => {
    const { url } = await serve('--api-key', 'k3y', '--auth-failures-per-minute', '3')
    for (const n of [1, 2, 3]) await client('send', url, 'x', '--api-key', `guess-${n}`)
    assert.match((await client('send', url, 'x', '--api-key', 'k3y')).error, /429 Too Many Requests/)
  })
})
