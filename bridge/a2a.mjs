// A2A bridge for the Claude Code `a2a` plugin.
//
// Client:  a2a card   <url>
//          a2a send   <url> <text> [--transport jsonrpc|rest|grpc] [--context-id ID] [--task-id ID]
//          a2a get    <url> <taskId> [--transport ...]
//          a2a cancel <url> <taskId> [--transport ...]
//          Credentials, as the agent card asks for them: [--api-key K] (or $A2A_API_KEY), [--token T] (or $A2A_TOKEN),
//          $A2A_HTTP_USERNAME and $A2A_HTTP_PASSWORD for HTTP Basic, or $A2A_OAUTH_CLIENT_ID (with
//          $A2A_OAUTH_CLIENT_SECRET, $A2A_OAUTH_SCOPE, $A2A_OAUTH_AUDIENCE, $A2A_OAUTH_REDIRECT_PORT) for an OAuth 2.0
//          grant. TLS: $A2A_TLS_CA to trust, $A2A_TLS_CERT and $A2A_TLS_KEY to present (PEM files). Card signatures:
//          $A2A_CARD_JWKS (a key set's URL or file) to trust, $A2A_REQUIRE_SIGNED_CARDS=1 to refuse unsigned cards.
//          $A2A_TOKEN_CACHE holds tokens from earlier calls, as {"type":"token"} lines reported them.
// Server:  a2a serve  --control <unix socket> [--host 127.0.0.1] [--port 41241] [--grpc-port 41242]
//                     [--transports all|http|grpc] [--api-key K (or $A2A_SERVE_API_KEY)]
//                     [--oidc-issuer URL --oidc-audience AUD [--required-scopes "S1 S2"]]
//                     [--tls-cert PEM --tls-key PEM [--tls-client-ca PEM]] [--card-signing-key PEM|JWK]
//                     [--max-concurrent-tasks 4] [--tasks-per-minute 30] [--auth-failures-per-minute 20]
//
// Output is NDJSON on stdout. `serve` prints {"type":"task",...} for every incoming
// task and waits for the plugin to POST the answer to /reply on the control socket. A client prints
// {"type":"login",url,code?} when a person must sign in, and {"type":"token",key,value} for each token it gets.
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { parseArgs } from 'node:util'
import {
  AGENT_CARD_PATH,
  AgentCard,
  CancelTaskRequest,
  GetTaskRequest,
  SendMessageRequest,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  taskStateToJSON,
} from '@a2a-js/sdk'
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from '@a2a-js/sdk/client'
import { GrpcTransportFactory } from '@a2a-js/sdk/client/grpc'
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server'
import { agentCardHandler, jsonRpcHandler, restHandler } from '@a2a-js/sdk/server/express'
import { A2AService, grpcService } from '@a2a-js/sdk/server/grpc'
import * as grpc from '@grpc/grpc-js'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { Agent, fetch as tlsFetch } from 'undici'

import { cardSigner, clientAuth, perMinute, serverAuth, verifyCard } from './auth.mjs'

// Read at run time, so a release bumps package.json alone and dist/ stays as built.
// From bridge/ and from dist/ alike, package.json is one folder up.
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const TRANSPORTS = { jsonrpc: 'JSONRPC', rest: 'HTTP+JSON', grpc: 'GRPC' }

const out = obj => process.stdout.write(`${JSON.stringify(obj)}\n`)
const stateName = s => taskStateToJSON(s).replace('TASK_STATE_', '').toLowerCase()

function partText(part) {
  const c = part.content
  if (!c) return ''
  if (c.$case === 'text' || c.$case === 'url') return c.value
  if (c.$case === 'data') return JSON.stringify(c.value)
  return `[${c.value.length} bytes ${part.mediaType || 'binary'}${part.filename ? ` ${part.filename}` : ''}]`
}
const partsText = (parts = []) => parts.map(partText).filter(Boolean).join('\n')

// ---------- client ----------

// TLS for every client connection: the CA to trust instead of the system's, and the certificate to present.
function clientTls() {
  const read = name => (process.env[name] ? readFileSync(process.env[name]) : undefined)
  const [ca, cert, key] = [read('A2A_TLS_CA'), read('A2A_TLS_CERT'), read('A2A_TLS_KEY')]
  if (Boolean(cert) !== Boolean(key)) throw new Error('A2A_TLS_CERT and A2A_TLS_KEY go together')
  const dispatcher = ca || cert ? new Agent({ connect: { ca, cert, key } }) : undefined
  return {
    fetch: dispatcher ? (input, init) => tlsFetch(input, { ...init, dispatcher }) : fetch,
    // The card names gRPC as host:port, so it goes over TLS when the card came over HTTPS, or TLS is configured.
    grpc: secure =>
      secure || ca || cert
        ? grpc.credentials.createSsl(ca ?? null, key ?? null, cert ?? null)
        : grpc.credentials.createInsecure(),
    clientCertificate: Boolean(cert),
  }
}

// The agent's card, with its signatures checked.
async function agent(url) {
  const tls = clientTls()
  const env = process.env
  const verify = card =>
    verifyCard(card, url, {
      fetch: tls.fetch,
      trustedKeys: env.A2A_CARD_JWKS || undefined,
      requireSigned: ['1', 'true'].includes(env.A2A_REQUIRE_SIGNED_CARDS),
    })
  const card = await new DefaultAgentCardResolver({ fetchImpl: tls.fetch }).resolve(url)
  return { url, card, signature: await verify(card), verify, tls }
}

// Tokens from earlier calls come in the environment; each new one is reported for the plugin to keep.
function tokenCache() {
  const cached = JSON.parse(process.env.A2A_TOKEN_CACHE || '{}')
  return {
    get: key => cached[key],
    set: (key, value) => {
      cached[key] = value
      out({ type: 'token', key, value })
    },
  }
}

// A client for the agent, carrying the credentials its card asks for.
async function connect({ url, card, tls }, opts, { interactive = true } = {}) {
  const { transport } = opts
  const preferred = transport ? [TRANSPORTS[transport]] : undefined
  if (transport && !preferred) throw new Error(`unknown transport "${transport}" (jsonrpc|rest|grpc)`)
  const env = process.env
  const credentials = {
    apiKey: opts['api-key'] || env.A2A_API_KEY || undefined,
    token: opts.token || env.A2A_TOKEN || undefined,
    username: env.A2A_HTTP_USERNAME || undefined,
    password: env.A2A_HTTP_PASSWORD || undefined,
    clientId: env.A2A_OAUTH_CLIENT_ID || undefined,
    clientSecret: env.A2A_OAUTH_CLIENT_SECRET || undefined,
    scope: env.A2A_OAUTH_SCOPE || undefined,
    audience: env.A2A_OAUTH_AUDIENCE || undefined,
    redirectPort: Number(env.A2A_OAUTH_REDIRECT_PORT) || 0,
    clientCertificate: tls.clientCertificate,
  }
  const { headers, query } = await clientAuth(card, credentials, {
    fetch: tls.fetch,
    tokens: tokenCache(),
    onLogin: login => out({ type: 'login', ...login }),
    interactive,
  })
  const inQuery = Object.keys(query).length > 0
  if (inQuery && transport === 'grpc') throw new Error('the agent wants its API key in the URL, which gRPC has not')
  const fetchImpl = inQuery
    ? (input, init) => {
        const at = new URL(String(input))
        for (const [name, value] of Object.entries(query)) at.searchParams.set(name, value)
        return tls.fetch(at, init)
      }
    : tls.fetch
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [
        new JsonRpcTransportFactory({ fetchImpl }),
        new RestTransportFactory({ fetchImpl }),
        ...(inQuery ? [] : [new GrpcTransportFactory({ grpcChannelCredentials: tls.grpc(url.startsWith('https:')) })]),
      ],
      preferredTransports: preferred,
    }),
  )
  const client = await factory.createFromAgentCard(card)
  // The SDK treats the choice as a preference; a named transport the agent lacks is an error.
  const offered = card.supportedInterfaces.map(i => i.protocolBinding)
  if (preferred && !offered.includes(preferred[0])) {
    throw new Error(`agent does not offer ${transport}; it offers ${offered.join(', ')}`)
  }
  return { client, options: Object.keys(headers).length ? { serviceParameters: headers } : undefined }
}

function summarizeTask(task) {
  return {
    taskId: task.id,
    contextId: task.contextId,
    state: task.status ? stateName(task.status.state) : 'unknown',
    status: partsText(task.status?.message?.parts),
    artifacts: task.artifacts.map(a => ({ name: a.name, text: partsText(a.parts) })),
  }
}

async function send(found, text, opts) {
  const { client, options } = await connect(found, opts)
  const request = SendMessageRequest.fromJSON({
    message: {
      messageId: randomUUID(),
      role: 'ROLE_USER',
      parts: [{ text }],
      contextId: opts['context-id'],
      taskId: opts['task-id'],
    },
  })
  const result = { taskId: '', contextId: '', state: '', status: '', artifacts: [], messages: [] }
  const artifacts = new Map()

  for await (const ev of client.sendMessageStream(request, options)) {
    const p = ev.payload
    if (!p) continue
    if (p.$case === 'message') {
      result.contextId ||= p.value.contextId
      result.messages.push(partsText(p.value.parts))
    } else if (p.$case === 'task') {
      Object.assign(result, summarizeTask(p.value), { messages: result.messages })
      for (const a of p.value.artifacts) artifacts.set(a.artifactId, { name: a.name, text: partsText(a.parts) })
    } else if (p.$case === 'statusUpdate') {
      const u = p.value
      result.taskId = u.taskId
      result.contextId = u.contextId
      result.state = stateName(u.status.state)
      result.status = partsText(u.status?.message?.parts)
      out({ type: 'progress', state: result.state, text: result.status })
    } else if (p.$case === 'artifactUpdate') {
      const { artifact, append } = p.value
      const prev = artifacts.get(artifact.artifactId)
      const chunk = partsText(artifact.parts)
      artifacts.set(artifact.artifactId, {
        name: artifact.name || prev?.name || '',
        text: append && prev ? prev.text + chunk : chunk,
      })
      out({ type: 'progress', state: result.state, text: chunk.slice(-200) })
    }
  }
  if (artifacts.size) result.artifacts = [...artifacts.values()]
  out({ type: 'result', ...result })
}

async function client(cmd, positionals, opts) {
  const [url, arg] = positionals
  if (!url) throw new Error(`usage: a2a ${cmd} <url> ...`)
  if (cmd !== 'card' && !arg) throw new Error(`usage: a2a ${cmd} <url> <${cmd === 'send' ? 'text' : 'taskId'}>`)
  const found = await agent(url)
  if (cmd === 'card') {
    // The extended card, for a client that can sign in without asking a person; the public one otherwise.
    const session = found.card.capabilities?.extendedAgentCard
      ? await connect(found, opts, { interactive: false }).catch(() => undefined)
      : undefined
    if (!session)
      return out({ type: 'result', card: AgentCard.toJSON(found.card), signature: found.signature, extended: false })
    // The SDK's client fetches the extended card when the public one says there is one.
    const card = await session.client.getAgentCard(session.options)
    return out({ type: 'result', card: AgentCard.toJSON(card), signature: await found.verify(card), extended: true })
  }
  if (cmd === 'send') return send(found, arg, opts)
  const { client: c, options } = await connect(found, opts)
  const task =
    cmd === 'get'
      ? await c.getTask(GetTaskRequest.fromJSON({ id: arg }), options)
      : await c.cancelTask(CancelTaskRequest.fromJSON({ id: arg }), options)
  out({ type: 'result', ...summarizeTask(task) })
}

// ---------- server ----------

// The authenticated caller, as the SDK carries it to the executor.
class Caller {
  constructor(name) {
    this.name = name
  }
  get isAuthenticated() {
    return this.name !== 'anonymous'
  }
  get userName() {
    return this.name
  }
}

async function serve(opts) {
  const host = opts.host
  const port = Number(opts.port)
  const grpcPort = Number(opts['grpc-port'])
  if (Boolean(opts['tls-cert']) !== Boolean(opts['tls-key'])) throw new Error('--tls-cert and --tls-key go together')
  if (opts['tls-client-ca'] && !opts['tls-cert']) throw new Error('--tls-client-ca needs --tls-cert and --tls-key')
  const tls = opts['tls-cert'] && { cert: readFileSync(opts['tls-cert']), key: readFileSync(opts['tls-key']) }
  const clientCa = opts['tls-client-ca'] && readFileSync(opts['tls-client-ca'])
  const auth = await serverAuth({
    apiKey: opts['api-key'] || process.env.A2A_SERVE_API_KEY || undefined,
    issuer: opts['oidc-issuer'],
    audience: opts['oidc-audience'],
    scopes: (opts['required-scopes'] ?? '').split(/[\s,]+/).filter(Boolean),
    mtls: Boolean(clientCa),
  })
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(host)
  if (!isLoopback && !auth.isConfigured) {
    throw new Error(
      `refusing to listen on ${host} without --api-key, --oidc-issuer or --tls-client-ca: incoming tasks run Claude Code with your tools`,
    )
  }
  if (!opts.control) throw new Error('--control <unix socket path> is required')
  if (!['all', 'http', 'grpc'].includes(opts.transports)) {
    throw new Error(`--transports must be all, http or grpc, not "${opts.transports}"`)
  }
  // The HTTP port always serves the agent card: clients discover every transport through it.
  // Each task runs a Claude turn: these keep any caller, signed in or not, from flooding the session.
  const maxConcurrent = Number(opts['max-concurrent-tasks'])
  const callerTasks = perMinute(Number(opts['tasks-per-minute']))
  const authFailuresPerMinute = Number(opts['auth-failures-per-minute'])
  const running = new Set()
  const withHttp = opts.transports !== 'grpc'
  const withGrpc = opts.transports !== 'http'

  const base = `${tls ? 'https' : 'http'}://${host}:${port}`
  const endpoints = {
    card: `${base}/${AGENT_CARD_PATH}`,
    ...(withHttp && { jsonrpc: `${base}/a2a/jsonrpc`, rest: `${base}/a2a/rest` }),
    ...(withGrpc && { grpc: `${host}:${grpcPort}` }),
  }
  const card = AgentCard.fromJSON({
    name: opts.name,
    description: 'Claude Code exposed over A2A. Each task runs in the host Claude Code session.',
    version: VERSION,
    supportedInterfaces: [
      endpoints.jsonrpc && { url: endpoints.jsonrpc, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      endpoints.rest && { url: endpoints.rest, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
      endpoints.grpc && { url: endpoints.grpc, protocolBinding: 'GRPC', protocolVersion: '1.0' },
    ].filter(Boolean),
    capabilities: { streaming: true, extendedAgentCard: auth.isConfigured },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        description: 'Software engineering: read, write and run code in the host workspace.',
        tags: ['coding', 'claude'],
      },
    ],
    // Any one requirement passes: each scheme is one of its own, with mutual TLS in every one when it is on.
    securitySchemes: auth.securitySchemes,
    securityRequirements: auth.securityRequirements,
  })
  const signer =
    opts['card-signing-key'] && (await cardSigner(opts['card-signing-key'], `${base}/.well-known/jwks.json`))
  const publicCard = signer ? await signer.sign(card) : card
  // A signed-in caller also learns the limits it will meet.
  const limit = (n, what) => (n > 0 ? `${n} ${what}` : `no limit on ${what}`)
  const extendedCard = AgentCard.fromJSON({
    ...AgentCard.toJSON(card),
    description: `${card.description} Limits: ${limit(maxConcurrent, 'tasks at once')}, ${limit(Number(opts['tasks-per-minute']), 'tasks a minute per caller')}.`,
  })

  // taskId -> resolve({ ok, text }) for the plugin's answer
  const pending = new Map()
  const status = (taskId, contextId, state, text) =>
    AgentEvent.statusUpdate(
      TaskStatusUpdateEvent.fromJSON({
        taskId,
        contextId,
        status: {
          state,
          timestamp: new Date().toISOString(),
          message: text && { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text }], taskId, contextId },
        },
      }),
    )

  const executor = {
    async execute(ctx, bus) {
      const { taskId, contextId, userMessage } = ctx
      if (!ctx.task) {
        const task = Task.fromJSON({ id: taskId, contextId, status: { state: 'TASK_STATE_SUBMITTED' } })
        task.history = [userMessage]
        bus.publish(AgentEvent.task(task))
      }
      const caller = ctx.context?.user?.userName ?? 'anonymous'
      // Refused before Claude runs it, so a refused task costs nothing.
      const refusal =
        maxConcurrent > 0 && running.size >= maxConcurrent
          ? `busy: ${running.size} tasks are running, the most this agent takes at once; try again later`
          : callerTasks.isFull(caller)
            ? 'rate limit: too many tasks from this caller in the last minute; try again later'
            : undefined
      if (refusal) {
        bus.publish(status(taskId, contextId, 'TASK_STATE_FAILED', refusal))
        bus.finished()
        return
      }
      callerTasks.add(caller)
      running.add(taskId)
      bus.publish(status(taskId, contextId, 'TASK_STATE_WORKING'))
      const answer = new Promise(resolve => pending.set(taskId, resolve))
      out({ type: 'task', taskId, contextId, caller, text: partsText(userMessage.parts) })
      const { ok, text, canceled } = await answer
      pending.delete(taskId)
      running.delete(taskId)
      if (!canceled) {
        bus.publish(
          AgentEvent.artifactUpdate(
            TaskArtifactUpdateEvent.fromJSON({
              taskId,
              contextId,
              artifact: { artifactId: randomUUID(), name: 'answer', parts: [{ text }] },
              lastChunk: true,
            }),
          ),
        )
        bus.publish(status(taskId, contextId, ok ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED', ok ? '' : text))
      }
      bus.finished()
    },
    async cancelTask(taskId, bus) {
      pending.get(taskId)?.({ canceled: true })
      out({ type: 'cancel', taskId })
      bus.publish(status(taskId, '', 'TASK_STATE_CANCELED'))
      bus.finished()
    },
  }

  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    executor,
    undefined,
    undefined,
    undefined,
    async ctx => (ctx.user?.isAuthenticated ? extendedCard : card),
    signer?.sign,
  )

  const app = express()
  // The agent card stays public: it is how clients learn which credentials to send. The handler sends what the
  // provider returns as is, so it gets the card's wire JSON, not the SDK's in-memory form.
  // A refusal says what to send (WWW-Authenticate); a token without the scopes needed is forbidden, not unknown.
  const peerName = socket => (socket.authorized ? (socket.getPeerCertificate().subject?.CN ?? 'client') : undefined)
  const authenticated = (req, res, nextMw) =>
    auth.authenticate({ headers: req.headers, peer: peerName(req.socket) }).then(
      ({ caller, error }) => {
        if (!caller) {
          for (const challenge of auth.challenges(error)) res.append('WWW-Authenticate', challenge)
          return error === 'insufficient_scope'
            ? res.status(403).type('text').send('forbidden: the token lacks a scope this agent requires')
            : res.status(401).type('text').send('unauthorized')
        }
        req.caller = caller
        nextMw()
      },
      err => nextMw(err),
    )
  const userBuilder = async req => new Caller(req.caller)
  // Refuses a client that keeps failing to authenticate, so a key cannot be guessed; successful calls do not count.
  const limited =
    authFailuresPerMinute > 0
      ? rateLimit({
          windowMs: 60_000,
          limit: authFailuresPerMinute,
          skipSuccessfulRequests: true,
          standardHeaders: 'draft-8',
          legacyHeaders: false,
        })
      : (_req, _res, nextMw) => nextMw()
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: async () => AgentCard.toJSON(publicCard) }))
  if (signer) app.get('/.well-known/jwks.json', (_req, res) => res.json(signer.jwks))
  if (withHttp) {
    app.use('/a2a/jsonrpc', limited, authenticated, jsonRpcHandler({ requestHandler, userBuilder }))
    app.use('/a2a/rest', limited, authenticated, restHandler({ requestHandler, userBuilder }))
  }
  // With a client CA the TLS layer refuses any connection without a certificate it signed, on both ports.
  const httpServer = tls
    ? https
        .createServer({ ...tls, ...(clientCa && { ca: clientCa, requestCert: true, rejectUnauthorized: true }) }, app)
        .listen(port, host)
    : app.listen(port, host)
  const httpUp = new Promise(resolve => httpServer.once('listening', resolve))

  const grpcFailures = perMinute(authFailuresPerMinute)
  const grpcServer = new grpc.Server()
  grpcServer.addService(
    A2AService,
    grpcService({
      requestHandler,
      userBuilder: async call => {
        const peer = call.getPeer().replace(/:\d+$/, '')
        if (grpcFailures.isFull(peer)) {
          throw Object.assign(new Error('too many failed attempts'), { code: grpc.status.RESOURCE_EXHAUSTED })
        }
        const header = name => call.metadata.get(name)[0]?.toString()
        const { caller, error } = await auth.authenticate({
          headers: { 'x-api-key': header('x-api-key'), authorization: header('authorization') },
          peer: call.getAuthContext?.()?.sslPeerCertificate?.subject?.CN,
        })
        if (!caller) {
          grpcFailures.add(peer)
          throw error === 'insufficient_scope'
            ? Object.assign(new Error('forbidden: the token lacks a scope this agent requires'), {
                code: grpc.status.PERMISSION_DENIED,
              })
            : Object.assign(new Error('unauthorized'), { code: grpc.status.UNAUTHENTICATED })
        }
        return new Caller(caller)
      },
    }),
  )

  // The plugin answers tasks here: POST /reply {taskId, ok, text}
  rmSync(opts.control, { force: true })
  const control = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => (body += d))
    req.on('end', () => {
      try {
        const { taskId, ok, text } = JSON.parse(body)
        const resolve = pending.get(taskId)
        if (!resolve) return res.writeHead(404).end('no such pending task')
        resolve({ ok: ok !== false, text: String(text ?? '') })
        res.writeHead(204).end()
      } catch (err) {
        res.writeHead(400).end(String(err))
      }
    })
  })
  control.listen(opts.control)

  const grpcUp =
    withGrpc &&
    new Promise((resolve, reject) =>
      grpcServer.bindAsync(
        endpoints.grpc,
        tls
          ? grpc.ServerCredentials.createSsl(
              clientCa || null,
              [{ cert_chain: tls.cert, private_key: tls.key }],
              Boolean(clientCa),
            )
          : grpc.ServerCredentials.createInsecure(),
        err => (err ? reject(err) : resolve()),
      ),
    )
  Promise.all([httpUp, grpcUp]).then(
    () => out({ type: 'ready', ...endpoints }),
    err => {
      throw err
    },
  )

  const stop = () => {
    grpcServer.forceShutdown()
    httpServer.close()
    control.close()
    rmSync(opts.control, { force: true })
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

// ---------- main ----------

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    transport: { type: 'string' },
    'context-id': { type: 'string' },
    'task-id': { type: 'string' },
    token: { type: 'string' },
    'api-key': { type: 'string' },
    'oidc-issuer': { type: 'string' },
    'oidc-audience': { type: 'string' },
    'required-scopes': { type: 'string' },
    'tls-cert': { type: 'string' },
    'tls-key': { type: 'string' },
    'tls-client-ca': { type: 'string' },
    'card-signing-key': { type: 'string' },
    'max-concurrent-tasks': { type: 'string', default: '4' },
    'tasks-per-minute': { type: 'string', default: '30' },
    'auth-failures-per-minute': { type: 'string', default: '20' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '41241' },
    'grpc-port': { type: 'string', default: '41242' },
    transports: { type: 'string', default: 'all' },
    name: { type: 'string', default: 'Claude Code' },
    control: { type: 'string' },
  },
})
const [cmd, ...rest] = positionals

// Listen failures (port in use, bad socket path) arrive as async errors.
process.on('uncaughtException', err => {
  out({ type: 'error', error: err?.message ?? String(err) })
  process.exit(1)
})

try {
  if (cmd === 'serve') await serve(values)
  else if (['card', 'send', 'get', 'cancel'].includes(cmd)) await client(cmd, rest, values)
  else throw new Error('usage: a2a card|send|get|cancel|serve ...')
} catch (err) {
  out({ type: 'error', error: err?.message ?? String(err) })
  process.exitCode = 1
}
