// End-to-end tests of the shipped bridge (dist/a2a.mjs): a real server, real clients,
// and this file playing the plugin's part of answering tasks over the control socket.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { after, describe, test } from 'node:test'
import { promisify } from 'node:util'

const BRIDGE = new URL('../dist/a2a.mjs', import.meta.url).pathname
const run = promisify(execFile)

const freePort = () =>
  new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

// Runs a client command; returns its last NDJSON line.
async function client(...args) {
  const { stdout } = await run('node', [BRIDGE, ...args], { env: { ...process.env, A2A_TOKEN: '' } }).catch(e => e)
  return JSON.parse(stdout.trim().split('\n').at(-1))
}

// Starts `serve` and answers every task with "echo: <text>", as the plugin would.
async function serve(...args) {
  const [port, grpcPort] = [await freePort(), await freePort()]
  const control = `/tmp/a2a-test-${randomUUID().slice(0, 8)}.sock`
  const child = spawn('node', [BRIDGE, 'serve', '--control', control, '--port', port, '--grpc-port', grpcPort, ...args])
  after(() => child.kill())

  let buffered = ''
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      buffered += chunk
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const msg = JSON.parse(buffered.slice(0, at))
        buffered = buffered.slice(at + 1)
        if (msg.type === 'ready') resolve(msg)
        if (msg.type === 'error') reject(new Error(msg.error))
        if (msg.type === 'task') {
          http
            .request({ socketPath: control, path: '/reply', method: 'POST' }, res => res.resume())
            .end(JSON.stringify({ taskId: msg.taskId, ok: true, text: `echo: ${msg.text}` }))
        }
      }
    })
  })
  return { url: `http://127.0.0.1:${port}`, ready: await ready }
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

describe('token', async () => {
  const { url } = await serve('--token', 's3cret')

  for (const transport of ['jsonrpc', 'rest', 'grpc']) {
    test(`${transport} refuses a call without the token and takes one with it`, async () => {
      assert.match((await client('send', url, 'x', '--transport', transport)).error, /401|unauthorized/i)
      const r = await client('send', url, 'x', '--transport', transport, '--token', 's3cret')
      assert.equal(r.state, 'completed')
    })
  }

  test('a non-loopback host without a token is refused', async () => {
    const r = await client('serve', '--control', '/tmp/a2a-unused.sock', '--host', '0.0.0.0')
    assert.match(r.error, /refusing to listen/)
  })
})
