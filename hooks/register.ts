import type { EngineInterface, PluginOptions, Register } from 'claude-code'

// The wire protocols (JSON-RPC + SSE, HTTP+JSON, gRPC) live in a Node bridge,
// dist/a2a.mjs: a hooks module has no sockets and $.http.fetch reads whole bodies.
const TOOL = (name: string) => `mcp__a2a__${name}`

type BridgeLine = { type: string; [key: string]: unknown }

async function* lines(stream: AsyncIterable<{ stream: string; text: string }>) {
  let buffered = ''
  for await (const { stream: pipe, text } of stream) {
    if (pipe !== 'stdout') continue
    buffered += text
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at).trim()
      buffered = buffered.slice(at + 1)
      if (line) yield JSON.parse(line) as BridgeLine
    }
  }
}

const bridge = ($: EngineInterface, args: string[], env?: Record<string, string>) =>
  $.process.spawn({ argv: ['node', `${$.plugin.root}/dist/a2a.mjs`, ...args], env })

const transportSchema = {
  type: 'string',
  enum: ['jsonrpc', 'rest', 'grpc'],
  description:
    "Wire protocol. jsonrpc = JSON-RPC over HTTP with SSE streaming. Default: the agent card's preferred one.",
}
const tokenSchema = {
  type: 'string',
  description:
    'Bearer token (a JWT), if the agent needs one and no saved OAuth client can fetch it. Default: $A2A_TOKEN.',
}
const apiKeySchema = {
  type: 'string',
  description:
    "API key, if the agent's card asks for one and it is not the saved client API key. Default: $A2A_API_KEY.",
}

// Tokens the bridge got, by its cache key, so a sign-in lasts the session. Kept in memory only, never on disk.
const tokens: Record<string, unknown> = {}

// Saved client credentials go to the bridge in its environment, over any the host sets; unset ones fall back to it.
function clientEnv(options: PluginOptions) {
  const env: Record<string, string> = {}
  const set = (name: string, value: unknown) => {
    if (value) env[name] = String(value)
  }
  set('A2A_API_KEY', options.clientApiKey)
  set('A2A_OAUTH_CLIENT_ID', options.oauthClientId)
  set('A2A_OAUTH_CLIENT_SECRET', options.oauthClientSecret)
  set('A2A_OAUTH_SCOPE', options.oauthScope)
  set('A2A_OAUTH_AUDIENCE', options.oauthAudience)
  set('A2A_OAUTH_REDIRECT_PORT', options.oauthRedirectPort)
  set('A2A_HTTP_USERNAME', options.clientUsername)
  set('A2A_HTTP_PASSWORD', options.clientPassword)
  set('A2A_TLS_CA', options.clientTlsCa)
  set('A2A_TLS_CERT', options.clientTlsCert)
  set('A2A_TLS_KEY', options.clientTlsKey)
  set('A2A_CARD_JWKS', options.trustedCardKeys)
  set('A2A_REQUIRE_SIGNED_CARDS', options.requireSignedCards && '1')
  if (Object.keys(tokens).length) env.A2A_TOKEN_CACHE = JSON.stringify(tokens)
  return env
}

// Where an incoming task runs: as a prompt in this conversation, in a subagent with a fresh context, or in a
// subagent that starts with a copy of this conversation.
const TASK_MODES = {
  inline: 'in this conversation, one at a time',
  subagent: 'as subagents with a fresh context',
  fork: 'as subagents that start with a copy of this conversation',
}
type TaskMode = keyof typeof TASK_MODES

// Server state lives in module variables: a reload kills the bridge child anyway.
let server: { stop: () => Promise<unknown>; socket: string; info: BridgeLine; taskMode: TaskMode } | undefined
// The A2A task each answer goes back to: by subagent id, or by the id of the main-thread turn that runs it.
const running = new Map<string, string>()
// Inline tasks submitted to this conversation but not started yet, by the line their prompt opens with.
const queued = new Map<string, string>()
const inlineHeader = (taskId: string, caller: unknown) =>
  `A2A task ${taskId} from ${caller}. Your final reply this turn goes back to them as the task's answer.`

async function reply($: EngineInterface, taskId: string, ok: boolean, text: string) {
  if (!server) return
  await $.http.fetch('http://a2a/reply', {
    method: 'POST',
    socketPath: server.socket,
    body: JSON.stringify({ taskId, ok, text }),
  })
}

// Saved settings (userConfig) first; flags typed after /a2a-serve win, as the
// bridge's parseArgs keeps the last value. The API key travels in env, not argv.
// --task-mode is the plugin's, not the bridge's, so it is taken out here.
function serveArgs(options: PluginOptions, typedArgs: string[]) {
  let taskMode = String(options.taskMode || 'inline')
  const typed: string[] = []
  for (let i = 0; i < typedArgs.length; i++) {
    if (typedArgs[i] === '--task-mode') taskMode = typedArgs[++i] ?? ''
    else typed.push(typedArgs[i])
  }
  const saved = [
    '--port',
    String(options.port ?? 41241),
    '--grpc-port',
    String(options.grpcPort ?? 41242),
    '--host',
    String(options.host || '127.0.0.1'),
    '--name',
    String(options.name || 'Claude Code'),
    '--transports',
    String(options.transports || 'all'),
  ]
  for (const [flag, option] of [
    ['--max-concurrent-tasks', 'maxConcurrentTasks'],
    ['--tasks-per-minute', 'tasksPerMinute'],
    ['--auth-failures-per-minute', 'authFailuresPerMinute'],
  ] as const) {
    if (options[option] !== undefined) saved.push(flag, String(options[option]))
  }
  if (options.oidcIssuer) saved.push('--oidc-issuer', String(options.oidcIssuer))
  for (const [flag, option] of [
    ['--oidc-audience', 'oidcAudience'],
    ['--required-scopes', 'requiredScopes'],
    ['--tls-cert', 'tlsCert'],
    ['--tls-key', 'tlsKey'],
    ['--tls-client-ca', 'tlsClientCa'],
    ['--card-signing-key', 'cardSigningKey'],
  ] as const) {
    if (options[option]) saved.push(flag, String(options[option]))
  }
  const env: Record<string, string> = options.apiKey ? { A2A_SERVE_API_KEY: String(options.apiKey) } : {}
  return { args: [...saved, ...typed], env, taskMode }
}

function startServer(
  $: EngineInterface,
  { args, env, taskMode: mode }: { args: string[]; env: Record<string, string>; taskMode: string },
): Promise<BridgeLine> {
  if (!(mode in TASK_MODES)) {
    return Promise.resolve({ type: 'error', error: `taskMode must be inline, subagent or fork, not "${mode}"` })
  }
  const taskMode = mode as TaskMode
  const socket = `/tmp/claude-a2a-${crypto.randomUUID().slice(0, 8)}.sock`
  const child = bridge($, ['serve', '--control', socket, ...args], env)
  return new Promise(resolve => {
    void (async () => {
      try {
        for await (const msg of lines(child)) {
          if (msg.type === 'ready') {
            server = { stop: () => child.return(undefined as never), socket, info: msg, taskMode }
            $.ui.status(`A2A ${[msg.jsonrpc, msg.grpc && `gRPC ${msg.grpc}`].filter(Boolean).join(' · ')}`)
            resolve(msg)
          } else if (msg.type === 'error') {
            resolve(msg)
          } else if (msg.type === 'task') {
            const taskId = String(msg.taskId)
            const text = String(msg.text)
            $.ui.toast(`A2A task from ${msg.caller}: ${text.slice(0, 60)}`)
            if (taskMode === 'inline') {
              // The prompt waits its turn while the person is working; turn.start ties it to the turn that runs it.
              const header = inlineHeader(taskId, msg.caller)
              queued.set(header, taskId)
              void $.prompt.submit({ text: `${header}\n\n${text}` }).then(entered => {
                if (entered.drop === undefined) return
                queued.delete(header)
                return reply($, taskId, false, entered.drop)
              })
            } else {
              const spawned = await $.agent.spawn({
                prompt: text,
                description: `A2A ${msg.caller} ${taskId.slice(0, 8)}`,
                ...(taskMode === 'fork' && { subagentType: 'fork' }),
              })
              if (spawned.deny !== undefined) await reply($, taskId, false, spawned.deny)
              else if (spawned.agentId) running.set(spawned.agentId, taskId)
            }
          } else if (msg.type === 'cancel') {
            for (const [header, taskId] of queued) if (taskId === msg.taskId) queued.delete(header)
            for (const [key, taskId] of running) {
              if (taskId !== msg.taskId) continue
              running.delete(key)
              // An inline task's key is its turn: stop it. A subagent is left to finish, unheard.
              if (taskMode === 'inline') await $.turn.abort({ turnId: key }).catch(() => undefined)
            }
          }
        }
      } catch (err) {
        resolve({ type: 'error', error: String(err) })
      } finally {
        server = undefined
        running.clear()
        queued.clear()
        $.ui.status(undefined)
      }
    })()
  })
}

const describeServer = (info: BridgeLine, taskMode: TaskMode) =>
  [
    `A2A server running. Incoming tasks run ${TASK_MODES[taskMode]} (taskMode ${taskMode}).`,
    `  card:     ${info.card}`,
    info.jsonrpc && `  jsonrpc:  ${info.jsonrpc}  (HTTP + SSE)`,
    info.rest && `  rest:     ${info.rest}`,
    info.grpc && `  grpc:     ${info.grpc}`,
  ]
    .filter(Boolean)
    .join('\n')

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await Promise.all([
      $.tool.register({
        name: 'card',
        description:
          "Fetch a remote A2A agent's agent card (name, skills, transports, security) from its base URL. " +
          'Returns the extended card when the saved credentials can sign in, and whether the card is signed and verified.',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      }),
      $.tool.register({
        name: 'send',
        description:
          'Send a message to a remote A2A agent and wait for the result (streams progress). ' +
          'Pass contextId to continue a conversation, taskId to answer a task in input-required or auth-required state. ' +
          'If the agent needs a person to sign in, the call shows them a URL and waits.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Agent base URL (the agent card is at /.well-known/agent-card.json).' },
            message: { type: 'string' },
            contextId: { type: 'string' },
            taskId: { type: 'string' },
            transport: transportSchema,
            token: tokenSchema,
            apiKey: apiKeySchema,
          },
          required: ['url', 'message'],
        },
      }),
      $.tool.register({
        name: 'get_task',
        description: 'Get the state and artifacts of a task on a remote A2A agent.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            taskId: { type: 'string' },
            transport: transportSchema,
            token: tokenSchema,
            apiKey: apiKeySchema,
          },
          required: ['url', 'taskId'],
        },
      }),
      $.tool.register({
        name: 'cancel_task',
        description: 'Cancel a task on a remote A2A agent.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            taskId: { type: 'string' },
            transport: transportSchema,
            token: tokenSchema,
            apiKey: apiKeySchema,
          },
          required: ['url', 'taskId'],
        },
      }),
      $.command.register({
        name: 'a2a-serve',
        description: 'Expose this session as an A2A agent (JSON-RPC/SSE, HTTP+JSON, gRPC)',
        argumentHint:
          '[--port 41241] [--grpc-port 41242] [--transports all|http|grpc] [--host 127.0.0.1] [--api-key K] [--oidc-issuer URL --oidc-audience AUD [--required-scopes S]] [--tls-cert PEM --tls-key PEM [--tls-client-ca PEM]] [--card-signing-key PEM] [--max-concurrent-tasks 4] [--tasks-per-minute 30] [--task-mode inline|subagent|fork] [--name N]',
      }),
      $.command.register({ name: 'a2a-stop', description: 'Stop the A2A server' }),
    ])
    if (options.autoServe) {
      void startServer($, serveArgs(options, [])).then(info => {
        if (info.type !== 'ready') $.ui.toast(`A2A server failed: ${info.error}`)
      })
    }
    return started
  })

  // Client: every tool runs one bridge command and returns its result line.
  on('tool.call', async ($, e, next) => {
    const cmd = {
      [TOOL('card')]: 'card',
      [TOOL('send')]: 'send',
      [TOOL('get_task')]: 'get',
      [TOOL('cancel_task')]: 'cancel',
    }[e.tool]
    if (!cmd) return next(e)

    const input = e as unknown as Record<string, string | undefined>
    const args = [cmd, String(input.url)]
    if (cmd === 'send') args.push(String(input.message))
    if (cmd === 'get' || cmd === 'cancel') args.push(String(input.taskId))
    if (input.contextId) args.push('--context-id', input.contextId)
    if (cmd === 'send' && input.taskId) args.push('--task-id', input.taskId)
    if (input.transport) args.push('--transport', input.transport)
    if (input.token) args.push('--token', input.token)
    if (input.apiKey) args.push('--api-key', input.apiKey)

    let last: BridgeLine = { type: 'error', error: 'bridge exited without a result' }
    for await (const msg of lines(bridge($, args, clientEnv(options)))) {
      if (msg.type === 'progress') $.ui.notice(e.tool_use_id, `${msg.state}: ${String(msg.text).slice(0, 120)}`)
      else if (msg.type === 'login') {
        // The call waits until the person signs in: on a device page with a code, or in the browser.
        const text = `Sign in to the A2A agent at ${msg.url}${msg.code ? ` with the code ${msg.code}` : ''}`
        $.ui.notice(e.tool_use_id, text)
        $.ui.toast(text)
      } else if (msg.type === 'token') tokens[String(msg.key)] = msg.value
      else last = msg
    }
    const { type, ...rest } = last
    const result = JSON.stringify(rest, null, 2)
    return type === 'error' ? { result, isError: true as const } : { result }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: the A2A bridge failed.` }))

  // Server, inline: the main-thread turn an A2A prompt starts is the one that answers it.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      for (const [header, taskId] of queued) {
        if (!e.text.includes(header)) continue
        queued.delete(header)
        running.set(e.turnId, taskId)
      }
    }
    return next(e)
  })

  // Server: hand each finished subagent's or inline turn's answer back to its A2A task.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const key = e.agentId ?? e.turnId
    const taskId = running.get(key)
    if (taskId) {
      running.delete(key)
      await reply($, taskId, e.reason === 'answer', e.answer || `the task ended: ${e.reason}`)
    }
    return done
  })

  on('command.run', { command: 'a2a-serve' }, async ($, e) => {
    if (server) return { text: describeServer(server.info, server.taskMode) }
    const info = await startServer($, serveArgs(options, e.args.split(/\s+/).filter(Boolean)))
    return {
      text:
        info.type === 'ready' && server ? describeServer(info, server.taskMode) : `A2A server failed: ${info.error}`,
    }
  })

  on('command.run', { command: 'a2a-stop' }, async () => {
    if (!server) return { text: 'A2A server is not running.' }
    await server.stop()
    return { text: 'A2A server stopped.' }
  })
}
