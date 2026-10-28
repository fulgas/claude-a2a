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
  '/a2a-serve starts from saved settings, typed flags win, the API key stays out of argv',
  {
    options: {
      port: 9300,
      grpcPort: 9301,
      transports: 'grpc',
      host: '127.0.0.1',
      name: 'Saved',
      apiKey: 's3cret',
      oidcIssuer: 'https://id.example.test',
      oidcAudience: 'a2a',
      maxConcurrentTasks: 2,
      tasksPerMinute: 10,
      authFailuresPerMinute: 5,
      requiredScopes: 'a2a.tasks',
      tlsCert: '/certs/server.pem',
      tlsKey: '/certs/server.key',
      tlsClientCa: '/certs/ca.pem',
      cardSigningKey: '/keys/card.pem',
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
      '--max-concurrent-tasks',
      '2',
      '--tasks-per-minute',
      '10',
      '--auth-failures-per-minute',
      '5',
      '--oidc-issuer',
      'https://id.example.test',
      '--oidc-audience',
      'a2a',
      '--required-scopes',
      'a2a.tasks',
      '--tls-cert',
      '/certs/server.pem',
      '--tls-key',
      '/certs/server.key',
      '--tls-client-ca',
      '/certs/ca.pem',
      '--card-signing-key',
      '/keys/card.pem',
      '--port',
      '9500',
    ])
    expect(request.argv.join(' ')).not.toContain('s3cret')
    expect(request.env).toEqual({ A2A_SERVE_API_KEY: 's3cret' })
    expect(ran.text).toContain('A2A server running')
  },
)

test(
  'client calls carry the saved client credentials in the environment, never in argv',
  {
    options: {
      clientApiKey: 'ck',
      oauthClientId: 'id',
      oauthClientSecret: 'shh',
      oauthScope: '',
      oauthAudience: 'aud',
      oauthRedirectPort: 8765,
      clientUsername: 'ann',
      clientPassword: 'pw',
      clientTlsCa: '/certs/ca.pem',
      clientTlsCert: '/certs/client.pem',
      clientTlsKey: '/certs/client.key',
      trustedCardKeys: 'https://keys.example.test/jwks.json',
      requireSignedCards: true,
    },
  },
  async ($, on) => {
    let request: { argv: readonly string[]; env?: Record<string, string> } = { argv: [] }
    on('process.spawn', async function* (_, e) {
      request = e
      return yield* spawned(['{"type":"result","card":{}}\n'])
    })

    await $.tool.call({ tool: 'mcp__a2a__card', url: 'http://agent.test' })

    expect(request.env).toEqual({
      A2A_API_KEY: 'ck',
      A2A_OAUTH_CLIENT_ID: 'id',
      A2A_OAUTH_CLIENT_SECRET: 'shh',
      A2A_OAUTH_AUDIENCE: 'aud',
      A2A_OAUTH_REDIRECT_PORT: '8765',
      A2A_HTTP_USERNAME: 'ann',
      A2A_HTTP_PASSWORD: 'pw',
      A2A_TLS_CA: '/certs/ca.pem',
      A2A_TLS_CERT: '/certs/client.pem',
      A2A_TLS_KEY: '/certs/client.key',
      A2A_CARD_JWKS: 'https://keys.example.test/jwks.json',
      A2A_REQUIRE_SIGNED_CARDS: '1',
    })
    expect(request.argv.join(' ')).not.toContain('shh')
    expect(request.argv.join(' ')).not.toContain('pw')
  },
)

test('a sign-in is shown to the person, and the token it gave is passed to the next call', async ($, on) => {
  const envs: (Record<string, string> | undefined)[] = []
  on('process.spawn', async function* (_, e) {
    envs.push(e.env)
    return yield* spawned([
      '{"type":"login","url":"https://id.example.test/activate","code":"WDJB-MJHT"}\n',
      '{"type":"token","key":"k1","value":{"accessToken":"at","expiresAt":1}}\n',
      '{"type":"result","taskId":"t1","state":"completed"}\n',
    ])
  })
  const notices: string[] = []
  const toasts: string[] = []
  on('ui.notice', (_, e) => {
    notices.push(String(e.text))
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  const first = await $.tool.call({ tool: 'mcp__a2a__send', url: 'http://agent.test', message: 'hi' })
  await $.tool.call({ tool: 'mcp__a2a__send', url: 'http://agent.test', message: 'again' })

  expect(JSON.parse(String(first.result))).toEqual({ taskId: 't1', state: 'completed' })
  const shown = 'Sign in to the A2A agent at https://id.example.test/activate with the code WDJB-MJHT'
  expect(notices).toContain(shown)
  expect(toasts).toContain(shown)
  expect(envs[0]?.A2A_TOKEN_CACHE).toBe(undefined)
  expect(JSON.parse(String(envs[1]?.A2A_TOKEN_CACHE))).toEqual({ k1: { accessToken: 'at', expiresAt: 1 } })
})
