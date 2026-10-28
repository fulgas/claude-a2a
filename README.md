# a2a: Agent2Agent for Claude Code

<p align="center"><img src="docs/assets/banner.svg" alt="A2A for Claude Code: call A2A agents, and serve your session as one" width="100%"></p>

<p align="center">
  <a href="https://github.com/fulgas/claude-a2a/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/fulgas/claude-a2a/actions/workflows/codeql.yml/badge.svg?branch=main"></a>
  <a href="SECURITY.md#verifying-a-release"><img alt="SLSA Build Level 2" src="https://slsa.dev/images/gh-badge-level2.svg" height="20"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/fulgas/claude-a2a"><img alt="OpenSSF Scorecard" src="https://api.scorecard.dev/projects/github.com/fulgas/claude-a2a/badge"></a>
</p>

Documentation: **[fulgas.github.io/claude-a2a](https://fulgas.github.io/claude-a2a/)**

A Claude Code plugin that speaks the [A2A protocol](https://a2a-protocol.org) in both directions:

- **Client.** Claude gets tools to call remote A2A agents over JSON-RPC (HTTP + SSE streaming), HTTP+JSON or gRPC.
- **Server.** `/a2a-serve` exposes your running session as an A2A agent on all three transports. Each incoming task runs as a subagent in that session, and its answer goes back as the task's artifact.

## Install

```
/plugin marketplace add fulgas/claude-a2a
/plugin install a2a@claude-a2a
```

Or, while developing: `claude --plugin-dir /path/to/claude-a2a`.

Requires Node 20+ on `PATH`. The bridge ships prebuilt in `dist/`, so there is no `npm install` step.

## Client tools

| Tool | Does |
| --- | --- |
| `mcp__a2a__card` | Fetches an agent card from a base URL |
| `mcp__a2a__send` | Sends a message and streams progress until the task settles. `contextId` continues a conversation, `taskId` answers an `input-required` task |
| `mcp__a2a__get_task` | Returns a task's state and artifacts |
| `mcp__a2a__cancel_task` | Cancels a task |

Every tool takes `transport` (`jsonrpc` \| `rest` \| `grpc`; the default is the agent card's preference). Credentials come from the saved client options or the environment (see [Authentication](#authentication)); `apiKey` and `token` override them for one call, but anything passed that way lands in the transcript.

## Server

```
/a2a-serve [--port 41241] [--grpc-port 41242] [--transports all|http|grpc] [--host 127.0.0.1]
           [--api-key K] [--oidc-issuer URL --oidc-audience AUD]
           [--max-concurrent-tasks 4] [--tasks-per-minute 30] [--auth-failures-per-minute 20] [--name N]
/a2a-stop
```

| Transport | Endpoint |
| --- | --- |
| Agent card | `http://HOST:PORT/.well-known/agent-card.json` |
| JSON-RPC + SSE | `http://HOST:PORT/a2a/jsonrpc` |
| HTTP+JSON | `http://HOST:PORT/a2a/rest` |
| gRPC | `HOST:GRPC_PORT` (plaintext) |

### Saved settings

Set defaults in `/plugin`, under the plugin's options, or in `settings.json`:

```json
{
  "pluginConfigs": {
    "a2a@claude-a2a": {
      "options": { "port": 9300, "grpcPort": 9301, "host": "127.0.0.1", "name": "My Claude", "autoServe": true }
    }
  }
}
```

| Option | Default | |
| --- | --- | --- |
| `port` | `41241` | HTTP port (card, JSON-RPC + SSE, HTTP+JSON) |
| `grpcPort` | `41242` | gRPC port |
| `transports` | `all` | `all`, `http` (JSON-RPC + HTTP+JSON) or `grpc`. In `grpc` mode the HTTP port serves only the agent card, which clients need to find the gRPC endpoint |
| `host` | `127.0.0.1` | Bind address. Anything else requires `apiKey` or `oidcIssuer` |
| `name` | `Claude Code` | Agent name in the card |
| `apiKey` | empty | API key callers may send in `X-API-Key`. Sensitive |
| `oidcIssuer` | empty | OIDC issuer whose JWTs callers may send as `Authorization: Bearer` |
| `oidcAudience` | empty | The `aud` those JWTs must carry. Required with `oidcIssuer` |
| `maxConcurrentTasks` | `4` | Incoming tasks that run at once; one more fails as busy. `0`: no limit |
| `tasksPerMinute` | `30` | Tasks one caller may start in a minute. `0`: no limit |
| `authFailuresPerMinute` | `20` | Failed sign-ins a client may make in a minute before it is refused (HTTP 429). `0`: no limit |
| `autoServe` | `false` | Start the server when a session starts |
| `clientApiKey` | `$A2A_API_KEY` | API key sent to agents whose card asks for one. Sensitive |
| `oauthClientId`, `oauthClientSecret` | `$A2A_OAUTH_CLIENT_ID`, `$A2A_OAUTH_CLIENT_SECRET` | OAuth2 client for the client-credentials grant. The secret is sensitive |
| `oauthScope`, `oauthAudience` | `$A2A_OAUTH_SCOPE`, `$A2A_OAUTH_AUDIENCE` | Scope and audience to ask the token endpoint for, when the provider needs them |

Sensitive options are kept in secure storage when set through `/plugin`.

Flags typed after `/a2a-serve` override the saved values for that run. Secrets reach the bridge through its environment, never on the command line.

## Authentication

**Server.** Incoming tasks run with this session's tools and permissions, so the server binds to `127.0.0.1` by default and refuses any other host unless at least one of these is set. With both set, either one lets a caller in:

- **API key:** callers send `X-API-Key: <key>` (gRPC: `x-api-key` metadata).
- **OIDC / OAuth2 JWT:** callers send `Authorization: Bearer <jwt>` from your identity provider. At start the server reads the issuer's discovery document and key set, then checks each token's signature (asymmetric algorithms only), `iss`, `aud` and `exp`. The token's `sub` names the caller in the task's toast.

The agent card advertises whichever schemes are on, and stays public, so clients can learn what to send.

**Limits.** Each task runs a Claude subagent on your tokens, so the server caps them: `maxConcurrentTasks` at once, and `tasksPerMinute` per caller (an API key, a JWT subject, or anonymous). A task over a limit fails at once, before any subagent starts, with a status that says which. A client that keeps failing to sign in is refused for the rest of the minute after `authFailuresPerMinute` attempts, so a key cannot be guessed.

**Client.** The tools read the remote agent's card and send what it asks for:

- an API key in the header its `apiKey` scheme names, from `clientApiKey` or `$A2A_API_KEY`
- a bearer token: `$A2A_TOKEN` as given, or one fetched with the OAuth2 client-credentials grant from the token endpoint the card names (its `oauth2` client-credentials flow, or its OIDC discovery document), when an OAuth client id and secret are set

gRPC and HTTP here are plaintext: put a TLS proxy in front before exposing the server beyond your machine, or a token can be read on the wire.

## How it works

The plugin's hooks module can't open sockets, so a Node bridge (`dist/a2a.mjs`, built on [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js)) speaks the wire protocols. Each incoming task runs as a subagent in your session. [docs/architecture.md](docs/architecture.md) has the full picture: arc42 sections, C4 diagrams and sequence diagrams.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) says.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT), at your option.
