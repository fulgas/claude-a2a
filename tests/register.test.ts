import { expect, test } from 'claude-code/testing'

// Nothing sits beneath the plugin here: each `on` hook stands for the engine.

// A stand-in for $.process.spawn: yields the child's stdout pieces, then
// answers its exit as { value }.
async function* spawned(pieces: string[], code = 0) {
  for (const text of pieces) yield { stream: 'stdout' as const, text }
  return { value: { code, signal: null } }
}

test('session start registers the client tools and server commands', async ($, on) => {
  const tools: string[] = []
  const commands: string[] = []
  on('tool.register', (_, e) => {
    tools.push(e.name)
    return { value: { tool: `mcp__a2a__${e.name}` } }
  })
  on('command.register', (_, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(tools.sort()).toEqual(['cancel_task', 'card', 'get_task', 'send'])
  expect(commands.sort()).toEqual(['a2a-serve', 'a2a-stop'])
})

test('send runs the bridge with the call input and returns its result line', async ($, on) => {
  let argv: readonly string[] = []
  on('process.spawn', async function* (_, e) {
    argv = e.argv
    // Pieces arrive cut anywhere, not on line ends.
    return yield* spawned([
      '{"type":"progress","state":"working","text":"hal',
      'f"}\n{"type":"result","taskId":"t1","state":"completed"}\n',
    ])
  })
  on('ui.notice', () => ({ value: undefined }))

  const ran = await $.tool.call({
    tool: 'mcp__a2a__send',
    url: 'http://agent.test',
    message: 'hi',
    contextId: 'c1',
    transport: 'grpc',
  })

  expect(argv.slice(2)).toEqual(['send', 'http://agent.test', 'hi', '--context-id', 'c1', '--transport', 'grpc'])
  expect(ran.isError).toBe(undefined)
  expect(JSON.parse(String(ran.result))).toEqual({ taskId: 't1', state: 'completed' })
})

test('a bridge error comes back as a tool error', async ($, on) => {
  on('process.spawn', async function* () {
    return yield* spawned(['{"type":"error","error":"fetch failed"}\n'], 1)
  })

  const ran = await $.tool.call({ tool: 'mcp__a2a__card', url: 'http://down.test' })

  expect(ran.isError).toBe(true)
  expect(JSON.parse(String(ran.result))).toEqual({ error: 'fetch failed' })
})

test(
  '/a2a-serve starts from saved settings, typed flags win, the token stays out of argv',
  {
    options: {
      port: 9300,
      grpcPort: 9301,
      transports: 'grpc',
      host: '127.0.0.1',
      name: 'Saved',
      token: 's3cret',
      autoServe: false,
    },
  },
  async ($, on) => {
    let request: { argv: readonly string[]; env?: Record<string, string> } = { argv: [] }
    on('process.spawn', async function* (_, e) {
      request = e
      return yield* spawned(['{"type":"ready","card":"c","jsonrpc":"j","rest":"r","grpc":"g"}\n'])
    })
    on('ui.status', () => ({ value: undefined }))

    const ran = await $.command.run({ command: 'a2a-serve', args: '--port 9500' })

    const args = request.argv.slice(request.argv.indexOf('serve') + 3)
    expect(args).toEqual([
      '--port',
      '9300',
      '--grpc-port',
      '9301',
      '--host',
      '127.0.0.1',
      '--name',
      'Saved',
      '--transports',
      'grpc',
      '--port',
      '9500',
    ])
    expect(request.argv.join(' ')).not.toContain('s3cret')
    expect(request.env).toEqual({ A2A_SERVE_TOKEN: 's3cret' })
    expect(ran.text).toContain('A2A server running')
  },
)
