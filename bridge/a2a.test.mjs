// End-to-end tests of the shipped bridge (dist/a2a.mjs): a real server, real clients,
// and this file playing the plugin's part of answering tasks over the control socket.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { promisify } from 'node:util'

import { authServer, certificates, freePort } from './test-support.mjs'

const BRIDGE = new URL('../dist/a2a.mjs', import.meta.url).pathname
const run = promisify(execFile)

// Runs a client command with no credentials from the environment but `env`; returns its last NDJSON line, or
// every line with `linesWith`.
const NO_CREDENTIALS = Object.fromEntries(
  [
    'A2A_TOKEN',
    'A2A_API_KEY',
    'A2A_OAUTH_CLIENT_ID',
    'A2A_OAUTH_CLIENT_SECRET',
    'A2A_TLS_CA',
    'A2A_TLS_CERT',
    'A2A_TLS_KEY',
    'A2A_CARD_JWKS',
    'A2A_REQUIRE_SIGNED_CARDS',
    'A2A_TOKEN_CACHE',
  ].map(name => [name, '']),
)
async function linesWith(env, ...args) {
  const options = { env: { ...process.env, ...NO_CREDENTIALS, ...env } }
  const { stdout } = await run('node', [BRIDGE, ...args], options).catch(e => e)
  return stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}
const clientWith = async (env, ...args) => (await linesWith(env, ...args)).at(-1)
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
  const up = await ready
  return { url: new URL(up.card).origin, ready: up, callers }
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
      assert.match((await client('send', url, 'x', '--transport', transport)).error, /none of them is configured/)
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
  const provider = await authServer()
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
      assert.match((await client('send', url, 'x', '--transport', transport)).error, /none of them is configured/)
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
  const provider = await authServer()
  const { url } = await serve('--api-key', 'k3y', '--oidc-issuer', provider.issuer, '--oidc-audience', 'a2a-test')

  test('either credential passes', async () => {
    assert.equal((await client('send', url, 'x', '--api-key', 'k3y')).state, 'completed')
    assert.equal((await client('send', url, 'x', '--token', await provider.sign())).state, 'completed')
    assert.match((await client('send', url, 'x')).error, /asks for apiKey .*, or oidc/)
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

describe('challenges', async () => {
  const provider = await authServer()
  const { url } = await serve('--api-key', 'k3y', '--oidc-issuer', provider.issuer, '--oidc-audience', 'a2a-test')

  test('a refusal says what to send in WWW-Authenticate, and why a token failed', async () => {
    const call = headers =>
      fetch(`${url}/a2a/jsonrpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      })
    const missing = await call({})
    assert.equal(missing.status, 401)
    assert.equal(
      missing.headers.get('www-authenticate'),
      'Bearer realm="a2a", APIKey realm="a2a", in="header", name="X-API-Key"',
    )
    const bad = await call({ authorization: 'Bearer not-a-jwt' })
    assert.match(bad.headers.get('www-authenticate'), /^Bearer realm="a2a", error="invalid_token"/)
  })
})

describe('OAuth 2.0 issuer without OpenID Connect', async () => {
  const provider = await authServer({ oidc: false })
  const { url, callers } = await serve('--oidc-issuer', provider.issuer, '--oidc-audience', 'a2a-test')

  test('the card names one OAuth 2.0 scheme per grant, with the metadata URL (RFC 8414)', async () => {
    const { card } = await client('card', url)
    const metadataUrl = `${provider.issuer}/.well-known/oauth-authorization-server`
    assert.deepEqual(Object.keys(card.securitySchemes), ['oauth2', 'oauth2-device', 'oauth2-code'])
    assert.equal(card.securitySchemes.oauth2.oauth2SecurityScheme.oauth2MetadataUrl, metadataUrl)
    assert.equal(
      card.securitySchemes.oauth2.oauth2SecurityScheme.flows.clientCredentials.tokenUrl,
      `${provider.issuer}/token`,
    )
    assert.ok(card.securitySchemes['oauth2-code'].oauth2SecurityScheme.flows.authorizationCode.pkceRequired)
  })

  for (const transport of ['jsonrpc', 'rest', 'grpc']) {
    test(`${transport}: the client signs in with client credentials`, async () => {
      const r = await clientWith(
        { A2A_OAUTH_CLIENT_ID: 'client', A2A_OAUTH_CLIENT_SECRET: 'secret' },
        'send',
        url,
        'x',
        '--transport',
        transport,
      )
      assert.equal(r.state, 'completed')
      assert.equal(callers.at(-1), 'oidc:agent-x')
    })
  }
})

describe('required scopes', async () => {
  const provider = await authServer()
  const { url } = await serve(
    ...['--oidc-issuer', provider.issuer, '--oidc-audience', 'a2a-test', '--required-scopes', 'a2a.tasks'],
  )

  test('the card lists them, a token without them is refused, and the client asks for them', async () => {
    const { card } = await client('card', url)
    assert.deepEqual(card.securityRequirements, [{ schemes: { oidc: { list: ['a2a.tasks'] } } }])
    const r = await client('send', url, 'x', '--token', await provider.sign())
    assert.match(r.error, /403|forbidden/i)
    const signedIn = await clientWith(
      { A2A_OAUTH_CLIENT_ID: 'client', A2A_OAUTH_CLIENT_SECRET: 'secret' },
      'send',
      url,
      'x',
    )
    assert.equal(signedIn.state, 'completed')
  })

  test('scopes without an issuer are refused at startup', async () => {
    const r = await client('serve', '--control', '/tmp/a2a-unused.sock', '--required-scopes', 'a2a.tasks')
    assert.match(r.error, /needs --oidc-issuer/)
  })
})

describe('tokens are kept between calls', async () => {
  const provider = await authServer()
  const { url } = await serve('--oidc-issuer', provider.issuer, '--oidc-audience', 'a2a-test')

  test('a call reports the token it got, and the next call given it asks for none', async () => {
    const env = { A2A_OAUTH_CLIENT_ID: 'client', A2A_OAUTH_CLIENT_SECRET: 'secret' }
    const first = await linesWith(env, 'send', url, 'x')
    const tokens = first.filter(line => line.type === 'token')
    assert.equal(tokens.length, 1)
    const grants = provider.grants.length
    const cache = JSON.stringify(Object.fromEntries(tokens.map(t => [t.key, t.value])))
    const second = await linesWith({ ...env, A2A_TOKEN_CACHE: cache }, 'send', url, 'x')
    assert.equal(second.at(-1).state, 'completed')
    assert.equal(provider.grants.length, grants)
    assert.deepEqual(
      second.filter(line => line.type === 'token'),
      [],
    )
  })
})

describe('TLS and mutual TLS', async () => {
  const certs = certificates()
  // On localhost, not 127.0.0.1: gRPC sends the host as the TLS server name, which Node refuses to be an address.
  const tls = ['--host', 'localhost', '--tls-cert', certs.serverCert, '--tls-key', certs.serverKey]
  const trusting = { A2A_TLS_CA: certs.ca }
  const withCertificate = { ...trusting, A2A_TLS_CERT: certs.clientCert, A2A_TLS_KEY: certs.clientKey }

  test('the server serves HTTPS and gRPC over TLS; the card names https endpoints', async () => {
    const { url, ready } = await serve(...tls)
    assert.match(ready.jsonrpc, /^https:/)
    for (const transport of ['jsonrpc', 'rest', 'grpc']) {
      const r = await clientWith(trusting, 'send', url, 'x', '--transport', transport)
      assert.equal(r.state, 'completed', `${transport}: ${r.error}`)
    }
    assert.equal((await client('card', url)).type, 'error', 'a client that does not trust the CA is refused')
  })

  test('with a client CA, every transport needs a client certificate, which names the caller', async () => {
    const { url, callers } = await serve(...tls, '--tls-client-ca', certs.ca)
    const { card } = await clientWith(withCertificate, 'card', url)
    assert.deepEqual(card.securitySchemes, { mtls: { mtlsSecurityScheme: {} } })
    for (const transport of ['jsonrpc', 'rest', 'grpc']) {
      assert.equal((await clientWith(trusting, 'send', url, 'x', '--transport', transport)).type, 'error')
      const r = await clientWith(withCertificate, 'send', url, 'x', '--transport', transport)
      assert.equal(r.state, 'completed', `${transport}: ${r.error}`)
      assert.equal(callers.at(-1), 'mtls:agent-y')
    }
  })

  test('mutual TLS goes with the API key: both are needed', async () => {
    const { url } = await serve(...tls, '--tls-client-ca', certs.ca, '--api-key', 'k3y')
    const { card } = await clientWith(withCertificate, 'card', url)
    assert.deepEqual(card.securityRequirements, [{ schemes: { apiKey: {}, mtls: {} } }])
    assert.match((await clientWith(withCertificate, 'send', url, 'x')).error, /API key/)
    assert.equal((await clientWith({ ...withCertificate, A2A_API_KEY: 'k3y' }, 'send', url, 'x')).state, 'completed')
  })

  test('a client CA without a server certificate is refused at startup', async () => {
    const r = await client('serve', '--control', '/tmp/a2a-unused.sock', '--tls-client-ca', certs.ca)
    assert.match(r.error, /--tls-client-ca needs --tls-cert/)
  })
})

describe('signed agent card', async () => {
  const keyFile = join(mkdtempSync(join(tmpdir(), 'a2a-card-')), 'card.key')
  writeFileSync(keyFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const { url } = await serve('--card-signing-key', keyFile)

  test('the card is signed with EdDSA, and its key set is served beside it', async () => {
    const r = await client('card', url)
    assert.equal(r.signature, 'verified')
    const header = JSON.parse(Buffer.from(r.card.signatures[0].protected, 'base64url'))
    assert.equal(header.alg, 'EdDSA')
    assert.equal(header.jku, `${url}/.well-known/jwks.json`)
    const jwks = await (await fetch(header.jku)).json()
    assert.equal(jwks.keys[0].kid, header.kid)
  })

  test('a client that requires signed cards refuses an unsigned one', async () => {
    const plain = await serve()
    assert.equal((await clientWith({ A2A_REQUIRE_SIGNED_CARDS: '1' }, 'send', url, 'x')).state, 'completed')
    assert.match((await clientWith({ A2A_REQUIRE_SIGNED_CARDS: '1' }, 'send', plain.url, 'x')).error, /not signed/)
  })
})

describe('extended agent card', async () => {
  const { url } = await serve('--api-key', 'k3y', '--max-concurrent-tasks', '3')

  test('a signed-in client gets the extended card; anyone else the public one', async () => {
    const pub = await client('card', url)
    assert.equal(pub.card.capabilities.extendedAgentCard, true)
    assert.equal(pub.extended, false)
    for (const transport of ['jsonrpc', 'rest', 'grpc']) {
      const r = await clientWith({ A2A_API_KEY: 'k3y' }, 'card', url, '--transport', transport)
      assert.equal(r.extended, true, `${transport}: ${r.error}`)
      assert.match(r.card.description, /3 tasks at once/)
    }
  })
})
