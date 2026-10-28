// A2A bridge for the Claude Code `a2a` plugin.
//
// Client:  a2a card   <url>
//          a2a send   <url> <text> [--transport jsonrpc|rest|grpc] [--context-id ID] [--task-id ID]
//          a2a get    <url> <taskId> [--transport ...]
//          a2a cancel <url> <taskId> [--transport ...]
//          Credentials, as the agent card asks for them: [--api-key K] (or $A2A_API_KEY), [--token T] (or $A2A_TOKEN),
//          or $A2A_OAUTH_CLIENT_ID and $A2A_OAUTH_CLIENT_SECRET (with $A2A_OAUTH_SCOPE, $A2A_OAUTH_AUDIENCE) to
//          fetch a token with the client-credentials grant.
// Server:  a2a serve  --control <unix socket> [--host 127.0.0.1] [--port 41241] [--grpc-port 41242]
//                     [--transports all|http|grpc] [--api-key K (or $A2A_SERVE_API_KEY)]
//                     [--oidc-issuer URL --oidc-audience AUD]
//
// Output is NDJSON on stdout. `serve` prints {"type":"task",...} for every incoming
// task and waits for the plugin to POST the answer to /reply on the control socket.
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
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
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory, RestTransportFactory } from '@a2a-js/sdk/client'
import { GrpcTransportFactory } from '@a2a-js/sdk/client/grpc'
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server'
import { agentCardHandler, jsonRpcHandler, restHandler } from '@a2a-js/sdk/server/express'
import { A2AService, grpcService } from '@a2a-js/sdk/server/grpc'
import * as grpc from '@grpc/grpc-js'
import express from 'express'

import { clientHeaders, serverAuth } from './auth.mjs'

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

async function connect(url, transport) {
  const preferred = transport ? [TRANSPORTS[transport]] : undefined
  if (transport && !preferred) throw new Error(`unknown transport "${transport}" (jsonrpc|rest|grpc)`)
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory(), new RestTransportFactory(), new GrpcTransportFactory()],
      preferredTransports: preferred,
    }),
  )
  const client = await factory.createFromUrl(url)
  const card = await client.getAgentCard()
  // The SDK treats the choice as a preference; a named transport the agent lacks is an error.
  const offered = card.supportedInterfaces.map(i => i.protocolBinding)
  if (preferred && !offered.includes(preferred[0])) {
    throw new Error(`agent does not offer ${transport}; it offers ${offered.join(', ')}`)
  }
  return { client, card }
}

// The credentials every call to this agent carries, as its card asks for them.
async function callOptions(card, opts) {
  const env = process.env
  const serviceParameters = await clientHeaders(card, {
    apiKey: opts['api-key'] || env.A2A_API_KEY || undefined,
    token: opts.token || env.A2A_TOKEN || undefined,
    clientId: env.A2A_OAUTH_CLIENT_ID,
    clientSecret: env.A2A_OAUTH_CLIENT_SECRET,
    scope: env.A2A_OAUTH_SCOPE,
    audience: env.A2A_OAUTH_AUDIENCE,
  })
  return serviceParameters && { serviceParameters }
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

async function send(url, text, opts) {
  const { client, card } = await connect(url, opts.transport)
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

  for await (const ev of client.sendMessageStream(request, await callOptions(card, opts))) {
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
  if (cmd === 'card') {
    const { card } = await connect(url, opts.transport)
    return out({ type: 'result', card: AgentCard.toJSON(card) })
  }
  if (!arg) throw new Error(`usage: a2a ${cmd} <url> <${cmd === 'send' ? 'text' : 'taskId'}>`)
  if (cmd === 'send') return send(url, arg, opts)
  const { client: c, card } = await connect(url, opts.transport)
  const options = await callOptions(card, opts)
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
  const auth = await serverAuth({
    apiKey: opts['api-key'] || process.env.A2A_SERVE_API_KEY || undefined,
    issuer: opts['oidc-issuer'],
    audience: opts['oidc-audience'],
  })
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(host)
  if (!isLoopback && !auth.isConfigured) {
    throw new Error(
      `refusing to listen on ${host} without --api-key or --oidc-issuer: incoming tasks run Claude Code with your tools`,
    )
  }
  if (!opts.control) throw new Error('--control <unix socket path> is required')
  if (!['all', 'http', 'grpc'].includes(opts.transports)) {
    throw new Error(`--transports must be all, http or grpc, not "${opts.transports}"`)
  }
  // The HTTP port always serves the agent card: clients discover every transport through it.
  const withHttp = opts.transports !== 'grpc'
  const withGrpc = opts.transports !== 'http'

  const base = `http://${host}:${port}`
  const endpoints = {
    card: `${base}/${AGENT_CARD_PATH}`,
    ...(withHttp && { jsonrpc: `${base}/a2a/jsonrpc`, rest: `${base}/a2a/rest` }),
    ...(withGrpc && { grpc: `${host}:${grpcPort}` }),
  }
  const card = AgentCard.fromJSON({
    name: opts.name,
    description: 'Claude Code exposed over A2A. Each task runs as a Claude Code subagent in the host session.',
    version: VERSION,
    supportedInterfaces: [
      endpoints.jsonrpc && { url: endpoints.jsonrpc, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      endpoints.rest && { url: endpoints.rest, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
      endpoints.grpc && { url: endpoints.grpc, protocolBinding: 'GRPC', protocolVersion: '1.0' },
    ].filter(Boolean),
    capabilities: { streaming: true },
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
    // Either scheme passes: the card lists each as a requirement of its own.
    securitySchemes: auth.securitySchemes,
    securityRequirements: auth.securityRequirements,
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
      bus.publish(status(taskId, contextId, 'TASK_STATE_WORKING'))
      const answer = new Promise(resolve => pending.set(taskId, resolve))
      const caller = ctx.context?.user?.userName ?? 'anonymous'
      out({ type: 'task', taskId, contextId, caller, text: partsText(userMessage.parts) })
      const { ok, text, canceled } = await answer
      pending.delete(taskId)
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

  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor)

  const app = express()
  // The agent card stays public: it is how clients learn which credentials to send. The handler sends what the
  // provider returns as is, so it gets the card's wire JSON, not the SDK's in-memory form.
  const authenticated = (req, res, nextMw) =>
    auth.authenticate(req.headers).then(
      caller => {
        if (!caller) return res.status(401).type('text').send('unauthorized')
        req.caller = caller
        nextMw()
      },
      err => nextMw(err),
    )
  const userBuilder = async req => new Caller(req.caller)
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: async () => AgentCard.toJSON(card) }))
  if (withHttp) {
    app.use('/a2a/jsonrpc', authenticated, jsonRpcHandler({ requestHandler, userBuilder }))
    app.use('/a2a/rest', authenticated, restHandler({ requestHandler, userBuilder }))
  }
  const httpServer = app.listen(port, host)
  const httpUp = new Promise(resolve => httpServer.once('listening', resolve))

  const grpcServer = new grpc.Server()
  grpcServer.addService(
    A2AService,
    grpcService({
      requestHandler,
      userBuilder: async call => {
        const header = name => call.metadata.get(name)[0]?.toString()
        const caller = await auth.authenticate({
          'x-api-key': header('x-api-key'),
          authorization: header('authorization'),
        })
        if (!caller) throw Object.assign(new Error('unauthorized'), { code: grpc.status.UNAUTHENTICATED })
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
      grpcServer.bindAsync(endpoints.grpc, grpc.ServerCredentials.createInsecure(), err =>
        err ? reject(err) : resolve(),
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
