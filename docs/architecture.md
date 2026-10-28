# Architecture

This document follows [arc42](https://arc42.org). Diagrams follow the [C4 model](https://c4model.com): each box names the element, its kind in brackets and what it does. They are written in Mermaid, so GitHub renders them in place.

## 1. Introduction and goals

`a2a` is a Claude Code plugin that speaks the [Agent2Agent (A2A) protocol](https://a2a-protocol.org) in both directions:

- **Client:** Claude calls remote A2A agents through four tools.
- **Server:** a running Claude Code session becomes an A2A agent. Each incoming task runs as a subagent in that session.

| Goal | What it means here |
| --- | --- |
| Every A2A transport | JSON-RPC over HTTP with SSE streaming, HTTP+JSON (REST), and gRPC, on both sides |
| Installs with one command | `/plugin install`, with no build step and no package install on the user's machine |
| Safe by default | The server listens on loopback only unless a token is set |

## 2. Constraints

| Constraint | Consequence |
| --- | --- |
| A Claude Code hooks module has no Node, no sockets and no DOM. It reaches the outside only through `$`. | The wire protocols live in a separate Node process: the bridge. |
| `$.http.fetch` resolves only after the whole body is read. | It cannot read an SSE stream or speak gRPC, which is one more reason for the bridge. |
| `$.process.spawn` closes the child's stdin after the first write. | The plugin answers the bridge over a Unix socket (`$.http.fetch` with `socketPath`), not over stdin. |
| Plugins install by copying the repository, with no `npm install`. | The bridge is bundled into one committed file, `dist/a2a.mjs`, and CI checks that it matches the source. |
| A2A clients find an agent by fetching its card over HTTP. | The HTTP port always serves the agent card, even in `grpc`-only mode. |

## 3. Context and scope

```mermaid
flowchart TB
  user(["<b>Developer</b><br/><small>[Person]</small><br/>Works in a Claude Code session"])
  claude["<b>Claude Code</b><br/><small>[Software system]</small><br/>The host: model, tools, permissions, subagents"]
  plugin["<b>a2a plugin</b><br/><small>[Software system]</small><br/>A2A client tools and an A2A server"]
  remote["<b>Remote A2A agent</b><br/><small>[Software system]</small><br/>Any agent that speaks A2A"]
  caller["<b>Calling A2A agent</b><br/><small>[Software system]</small><br/>Any A2A client that sends tasks here"]
  user -- "Prompts, /a2a-serve, /a2a-stop" --> claude
  claude -- "Loads it, calls its tools, runs its hooks" --> plugin
  plugin -- "Runs each incoming task as a subagent" --> claude
  plugin -- "Sends messages, reads tasks<br/>JSON-RPC+SSE · HTTP+JSON · gRPC" --> remote
  caller -- "Sends tasks<br/>JSON-RPC+SSE · HTTP+JSON · gRPC" --> plugin
  classDef person fill:#8E3820,stroke:#6E2A17,color:#fff
  classDef system fill:#B5472A,stroke:#8E3820,color:#fff
  classDef container fill:#F6E4DC,stroke:#B5472A,color:#1F1B17
  classDef external fill:#EDE6DD,stroke:#8A8178,color:#1F1B17
  class user person
  class plugin system
  class claude,remote,caller external
```

| Neighbour | Exchanges |
| --- | --- |
| Developer | Asks Claude to talk to an agent; starts and stops the server; sets the plugin's options |
| Claude Code | Loads the plugin, offers its tools to the model, runs subagents, enforces permissions |
| Remote A2A agent | Agent card, messages, tasks, artifacts |
| Calling A2A agent | The same, in the other direction |

## 4. Solution strategy

- **Split by capability.** The hooks module does what only it can do: register tools and commands, spawn subagents, and read their answers. The bridge does what only Node can do: sockets, HTTP/2, SSE and gRPC.
- **Use the official SDK.** The bridge is a thin layer over [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js). The protocol logic stays upstream.
- **NDJSON between the two.** The bridge writes one JSON object per line on stdout. The plugin reads them as they arrive.
- **Subagents as the server's brain.** An incoming task becomes `$.agent.spawn({ prompt })`. Its `turn.complete` answer becomes the task's artifact.

## 5. Building block view

### Level 2: containers

```mermaid
flowchart TB
  claude["<b>Claude Code engine</b><br/><small>[Software system]</small><br/>Model, subagents, permissions"]
  other["<b>Other A2A agents</b><br/><small>[Software system]</small>"]
  subgraph plugin["a2a plugin"]
    mod["<b>Hooks module</b><br/><small>[Container: TypeScript, hooks/register.ts]</small><br/>Tools, slash commands, subagent routing"]
    bridge["<b>Bridge</b><br/><small>[Container: Node 20+, dist/a2a.mjs]</small><br/>A2A client and server on @a2a-js/sdk"]
    socket[("<b>Control socket</b><br/><small>[Container: Unix socket in /tmp]</small><br/>The plugin's answers to the bridge")]
  end
  claude -- "session.start, tool.call,<br/>command.run, turn.complete" --> mod
  mod -- "$.tool.register, $.agent.spawn, $.ui" --> claude
  mod -- "Spawns it, reads NDJSON on stdout" --> bridge
  mod -- "POST /reply" --> socket
  socket -- "Resolves the waiting task" --> bridge
  bridge <-- "A2A<br/>JSON-RPC+SSE · HTTP+JSON · gRPC" --> other
  classDef person fill:#8E3820,stroke:#6E2A17,color:#fff
  classDef system fill:#B5472A,stroke:#8E3820,color:#fff
  classDef container fill:#F6E4DC,stroke:#B5472A,color:#1F1B17
  classDef external fill:#EDE6DD,stroke:#8A8178,color:#1F1B17
  class mod,bridge,socket container
  class claude,other external
```

### Level 3: components

```mermaid
flowchart LR
  subgraph mod["Hooks module · hooks/register.ts"]
    reg["<b>session.start hook</b><br/><small>[Component]</small><br/>Registers the 4 tools and 2 commands, auto-starts the server"]
    tools["<b>tool.call hook</b><br/><small>[Component]</small><br/>card, send, get_task, cancel_task"]
    cmds["<b>command.run hooks</b><br/><small>[Component]</small><br/>/a2a-serve, /a2a-stop, saved options plus typed flags"]
    router["<b>Task router</b><br/><small>[Component]</small><br/>Task line to $.agent.spawn, agentId to taskId"]
    done["<b>turn.complete hook</b><br/><small>[Component]</small><br/>A subagent's answer to POST /reply"]
  end
  subgraph bridge["Bridge · bridge/a2a.mjs"]
    cli["<b>Client commands</b><br/><small>[Component]</small><br/>ClientFactory with JSON-RPC, REST and gRPC"]
    card["<b>Agent card</b><br/><small>[Component]</small><br/>Lists only the enabled interfaces"]
    http["<b>HTTP server</b><br/><small>[Component: Express]</small><br/>Card, /a2a/jsonrpc, /a2a/rest, bearer check"]
    grpc["<b>gRPC server</b><br/><small>[Component: grpc-js]</small><br/>A2AService, bearer check in metadata"]
    exec["<b>Executor</b><br/><small>[Component]</small><br/>Publishes a task, prints it, waits for /reply"]
    ctl["<b>Control server</b><br/><small>[Component]</small><br/>HTTP on the Unix socket: /reply"]
  end
  tools -- "argv, NDJSON back" --> cli
  cmds -- "Starts serve" --> router
  http --> exec
  grpc --> exec
  http -- "serves" --> card
  exec -- "task line on stdout" --> router
  done -- "POST /reply" --> ctl
  ctl -- "Resolves the task" --> exec
  classDef person fill:#8E3820,stroke:#6E2A17,color:#fff
  classDef system fill:#B5472A,stroke:#8E3820,color:#fff
  classDef container fill:#F6E4DC,stroke:#B5472A,color:#1F1B17
  classDef external fill:#EDE6DD,stroke:#8A8178,color:#1F1B17
  class reg,tools,cmds,router,done,cli,card,http,grpc,exec,ctl container
```

| Building block | Source |
| --- | --- |
| Hooks module | `hooks/register.ts` |
| Bridge | `bridge/a2a.mjs`, bundled to `dist/a2a.mjs` |
| Plugin manifest and options | `.claude-plugin/plugin.json` |
| Marketplace entry | `.claude-plugin/marketplace.json` |

## 6. Runtime view

### Calling another agent

```mermaid
sequenceDiagram
  autonumber
  participant M as Model
  participant P as Hooks module
  participant B as Bridge (a2a.mjs send)
  participant R as Remote agent

  M->>P: tool call mcp__a2a__send {url, message, transport?}
  P->>B: $.process.spawn(node a2a.mjs send ...)
  B->>R: GET /.well-known/agent-card.json
  R-->>B: agent card (interfaces)
  Note over B: picks the named transport,<br/>or fails if the card lacks it
  B->>R: SendStreamingMessage
  loop while the task runs
    R-->>B: status / artifact update
    B-->>P: {"type":"progress"} line
    P-->>M: notice under the tool call
  end
  B-->>P: {"type":"result", taskId, contextId, state, artifacts}
  P-->>M: tool result (JSON)
```

### Receiving a task

```mermaid
sequenceDiagram
  autonumber
  participant C as Calling agent
  participant B as Bridge (a2a.mjs serve)
  participant P as Hooks module
  participant E as Claude Code engine
  participant S as Subagent

  C->>B: SendMessage (JSON-RPC, REST or gRPC, with bearer if set)
  B-->>C: task (working)
  B->>P: {"type":"task", taskId, text} line
  P->>E: $.agent.spawn({prompt: text})
  E->>S: runs with the session's tools and permissions
  S-->>E: final answer
  E->>P: turn.complete {agentId, answer}
  P->>B: POST /reply {taskId, ok, text} on the control socket
  B-->>C: artifact "answer", then status completed
```

### Starting the server

`/a2a-serve` merges the saved options with the typed flags (typed flags win) and spawns `a2a.mjs serve`. The token travels in the environment as `A2A_SERVE_TOKEN`. The bridge binds the HTTP port and, unless `transports` is `http`, the gRPC port, then prints `{"type":"ready"}` with the endpoints. The plugin shows them in the status line. `/a2a-stop`, or the end of the session, ends the spawn loop, which kills the bridge.

## 7. Deployment view

```mermaid
flowchart LR
  subgraph machine["Developer machine"]
    subgraph cc["Claude Code process"]
      mod["hooks/register.ts"]
    end
    bridge["node dist/a2a.mjs serve"]
    sock[("/tmp/claude-a2a-*.sock")]
    mod -- spawn, stdout --> bridge
    mod -- POST /reply --> sock --> bridge
  end
  caller["Calling agent"] -- "HTTP :41241 (card, JSON-RPC+SSE, REST)" --> bridge
  caller -- "gRPC :41242" --> bridge
```

- One bridge process per session that runs `/a2a-serve`. Client calls start a short-lived bridge each.
- Defaults: HTTP on `41241`, gRPC on `41242`, bound to `127.0.0.1`.
- The plugin itself installs from the `fulgas/claude-a2a` marketplace. The release is the git tag, and its files are the repository's contents at that tag.

## 8. Cross-cutting concepts

**Security.**
- An incoming message becomes a prompt that runs with the session's tools and permissions. The server is therefore loopback-only unless a token is set; the bridge refuses any other host without one.
- With a token, every HTTP request needs `Authorization: Bearer <token>` and every gRPC call needs the `authorization` metadata. The comparison is constant-time.
- The token reaches the bridge through the environment, never argv, so `ps` does not show it.
- There is no TLS. Exposing the server beyond the machine needs a TLS proxy in front.
- Claude Code's own permission prompts still apply to what the subagent does.

**Supply chain.** What runs on a user's machine is the hooks module and `dist/a2a.mjs`, which bundles the bridge's dependencies, so those are guarded hardest.
- CI rebuilds `dist/a2a.mjs` from the source and the lockfile and fails if it differs, so the committed bundle cannot carry code the source does not.
- `npm audit` gates known vulnerabilities in the bundled dependencies, and dependency review refuses a pull request that adds a vulnerable or GPL-licensed one. `npm audit signatures` checks every package against the registry's signatures and provenance.
- Every GitHub Action is pinned to a commit SHA; zizmor audits the workflows, and every workflow token has only the permissions its job needs. CodeQL analyses the code and the workflows; OpenSSF Scorecard rates the whole repository.
- The Zola binary that builds the docs site is checked against its SHA-256 before it runs.
- Commits and tags are signed, `main` changes only through reviewed pull requests, and releases are immutable. Secret scanning with push protection refuses a pushed credential.

**Configuration.** The plugin's `userConfig` (`port`, `grpcPort`, `transports`, `host`, `name`, `token`, `autoServe`) lives in `pluginConfigs` in settings. The token is marked sensitive, so `/plugin` keeps it in secure storage. Flags typed after `/a2a-serve` override saved values for that run. On the client side, `A2A_TOKEN` is the default bearer token.

**Errors.** Every bridge failure becomes a `{"type":"error"}` line. The plugin turns it into a tool error the model can read. A subagent that ends without an answer fails its A2A task with the reason.

**Versioning.** One version for the plugin, `package.json` and the agent card. release-please keeps them in step from Conventional Commits.

## 9. Architecture decisions

| Decision | Why | Rejected |
| --- | --- | --- |
| A hooks-module plugin, not an MCP server | Native to Claude Code: tools, commands, subagents and the status line from one module | An MCP server: no subagents, no slash commands |
| A Node bridge on `@a2a-js/sdk` | Official SDK with all three transports, client and server; Node is already a Claude Code requirement | Python `a2a-sdk`: another runtime to install |
| Commit the bundled `dist/a2a.mjs` | Plugins install with no `npm install` | Install dependencies on first run: slow and fragile offline |
| Unix control socket for answers | `$.process.spawn` stdin is one-shot; `$.http.fetch` can use a socket path | A TCP port: reachable by other local users |
| Subagent per task | Isolated context per task; the session stays usable | Prompting the main conversation: interleaves with the user's own work |
| HTTP card even in gRPC-only mode | A2A discovery is the HTTP card | gRPC-only with no card: clients cannot find it |

## 10. Quality requirements

| Quality | Scenario | Measured by |
| --- | --- | --- |
| Interoperability | A JSON-RPC, REST or gRPC client completes a task | `bridge/a2a.test.mjs`, per transport |
| Security | A call without the token is refused on every transport | `bridge/a2a.test.mjs`, token suite |
| Security | The token never appears in argv | `tests/register.test.ts` |
| Correctness | A named transport the agent lacks is an error, not a silent fallback | `bridge/a2a.test.mjs` |
| Installability | `dist/` matches the source | CI `Test` job |

## 11. Risks and technical debt

- **No memory across tasks.** Each task is a fresh subagent, so a follow-up in the same A2A context does not see the earlier turns.
- **Final answer only.** A caller sees the answer when the subagent finishes, not its progress.
- **Session-bound server.** The server lives as long as the session. There is no daemon mode.
- **No TLS and no push notifications** on the server side.
- **Early-access plugin API.** Claude Code's hooks-module API may change between releases. CI pins the Claude Code version it validates against.

## 12. Glossary

| Term | Meaning |
| --- | --- |
| A2A | Agent2Agent, an open protocol for agents to call each other |
| Agent card | JSON at `/.well-known/agent-card.json` naming an agent, its skills and its endpoints |
| Task | A unit of work on an A2A agent, with a state (`working`, `completed`, ...) and artifacts |
| Artifact | An output of a task, made of parts (text, data, files) |
| Context | A conversation that groups tasks; `contextId` |
| Bridge | `dist/a2a.mjs`, the Node process that speaks A2A for the plugin |
| Hooks module | `hooks/register.ts`, the plugin code Claude Code runs |
| Control socket | The Unix socket the plugin uses to answer the bridge |
