// A2A bridge for the Claude Code `a2a` plugin.
//
// Client:  a2a card   <url>
//          a2a send   <url> <text> [--transport jsonrpc|rest|grpc] [--context-id ID] [--task-id ID] [--token T]
//          a2a get    <url> <taskId> [--transport ...] [--token T]
//          a2a cancel <url> <taskId> [--transport ...] [--token T]
// Server:  a2a serve  --control <unix socket> [--host 127.0.0.1] [--port 41241] [--grpc-port 41242]
//                     [--transports all|http|grpc] [--token T (or $A2A_SERVE_TOKEN)]
//
// Output is NDJSON on stdout. `serve` prints {"type":"task",...} for every incoming
// task and waits for the plugin to POST the answer to /reply on the control socket.
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
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
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, UnauthenticatedUser } from '@a2a-js/sdk/server'
import { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } from '@a2a-js/sdk/server/express'
import { A2AService, grpcService } from '@a2a-js/sdk/server/grpc'
import * as grpc from '@grpc/grpc-js'
import express from 'express'

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
  // The SDK treats the choice as a preference; a named transport the agent lacks is an error.
  const offered = (await client.getAgentCard()).supportedInterfaces.map(i => i.protocolBinding)
  if (preferred && !offered.includes(preferred[0])) {
    throw new Error(`agent does not offer ${transport}; it offers ${offered.join(', ')}`)
  }
  return client
}

const callOptions = (token = process.env.A2A_TOKEN) =>
  token ? { serviceParameters: { authorization: `Bearer ${token}` } } : undefined

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
  const client = await connect(url, opts.transport)
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

  for await (const ev of client.sendMessageStream(request, callOptions(opts.token))) {
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
    const c = await connect(url, opts.transport)
    return out({ type: 'result', card: AgentCard.toJSON(await c.getAgentCard()) })
  }
  if (!arg) throw new Error(`usage: a2a ${cmd} <url> <${cmd === 'send' ? 'text' : 'taskId'}>`)
  if (cmd === 'send') return send(url, arg, opts)
  const c = await connect(url, opts.transport)
  const task =
    cmd === 'get'
      ? await c.getTask(GetTaskRequest.fromJSON({ id: arg }), callOptions(opts.token))
      : await c.cancelTask(CancelTaskRequest.fromJSON({ id: arg }), callOptions(opts.token))
  out({ type: 'result', ...summarizeTask(task) })
}

// ---------- server ----------

function serve(opts) {
  const host = opts.host
  const port = Number(opts.port)
  const grpcPort = Number(opts['grpc-port'])
  const token = opts.token || process.env.A2A_SERVE_TOKEN
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(host)
  if (!isLoopback && !token) {
    throw new Error(`refusing to listen on ${host} without --token: incoming tasks run Claude Code with your tools`)
  }
  if (!opts.control) throw new Error('--control <unix socket path> is required')
  if (!['all', 'http', 'grpc'].includes(opts.transports)) {
    throw new Error(`--transports must be all, http or grpc, not "${opts.transports}"`)
  }
  // The HTTP port always serves the agent card: clients discover every transport through it.
  const withHttp = opts.transports !== 'grpc'
  const withGrpc = opts.transports !== 'http'

  const tokenOk = header => {
    if (!token) return true
    const want = Buffer.from(`Bearer ${token}`)
    const got = Buffer.from(String(header ?? ''))
    return got.length === want.length && timingSafeEqual(got, want)
  }

  const base = `http://${host}:${port}`
  const endpoints = {
    card: `${base}/${AGENT_CARD_PATH}`,
    ...(withHttp && { jsonrpc: `${base}/a2a/jsonrpc`, rest: `${base}/a2a/rest` }),
    ...(withGrpc && { grpc: `${host}:${grpcPort}` }),
  }
  const card = AgentCard.fromJSON({
    name: opts.name,
    description: 'Claude Code exposed over A2A. Each task runs as a Claude Code subagent in the host session.',
    version: '0.1.0', // x-release-please-version
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
    securitySchemes: token ? { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } } : undefined,
    securityRequirements: token ? [{ schemes: { bearer: { list: [] } } }] : undefined,
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
      out({ type: 'task', taskId, contextId, text: partsText(userMessage.parts) })
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
  const auth = (req, res, nextMw) =>
    tokenOk(req.headers.authorization) ? nextMw() : res.status(401).type('text').send('unauthorized')
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: async () => card }))
  if (withHttp) {
    app.use('/a2a/jsonrpc', auth, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }))
    app.use('/a2a/rest', auth, restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }))
  }
  const httpServer = app.listen(port, host)
  const httpUp = new Promise(resolve => httpServer.once('listening', resolve))

  const grpcServer = new grpc.Server()
  grpcServer.addService(
    A2AService,
    grpcService({
      requestHandler,
      userBuilder: async call => {
        if (!tokenOk(call.metadata.get('authorization')[0])) {
          throw Object.assign(new Error('unauthorized'), { code: grpc.status.UNAUTHENTICATED })
        }
        return new UnauthenticatedUser()
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
  if (cmd === 'serve') serve(values)
  else if (['card', 'send', 'get', 'cancel'].includes(cmd)) await client(cmd, rest, values)
  else throw new Error('usage: a2a card|send|get|cancel|serve ...')
} catch (err) {
  out({ type: 'error', error: err?.message ?? String(err) })
  process.exitCode = 1
}
