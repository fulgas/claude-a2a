# Health probes extension, v1

URI: `https://github.com/fulgas/claude-a2a/blob/main/docs/extensions/health-v1.md`

An agent that declares this extension serves two health probes, so a gateway or a container's health check can tell whether the agent can take a task, not only whether its card is served. claude-a2a declares it on every card.

## Declaration

```json
{
  "uri": "https://github.com/fulgas/claude-a2a/blob/main/docs/extensions/health-v1.md",
  "description": "Health probes",
  "required": false,
  "params": { "livez": "/livez", "readyz": "/readyz" }
}
```

- `required` is false: a client that ignores the extension works as before. Protobuf JSON leaves out a false `required`, so a served card may not show it.
- `params.livez` and `params.readyz` are paths, resolved against the origin of the card's own interface URL. A client should refuse a path that resolves to another origin.

## Probes

Both are `GET`, unauthenticated, and answer JSON at once, without calling a model.

| Probe | Answer |
| --- | --- |
| `livez` | `200 {"status":"live"}` while the agent's process is up |
| `readyz` | `200 {"status":"ready"}` when the agent can take a task, or `503 {"status":"not_ready","reason":"…"}` when it cannot |

`reason` is one line, at most 200 characters, that a gateway may show to people. It never holds a secret or an error's own text.

With mutual TLS, the probes are on the same port, so a probe needs a client certificate too.

## While not ready

A new task (`SendMessage`, `SendStreamingMessage`) is refused at once with `not ready: <reason>`, instead of being started only to fail:

| Binding | Refusal |
| --- | --- |
| HTTP+JSON | `503`, `application/a2a+json`, `{"error":{"code":503,"status":"UNAVAILABLE","message":"not ready: …"}}` |
| JSON-RPC | `503`, a JSON-RPC error with code `-32603` |
| gRPC | status `UNAVAILABLE` (14) |

Other calls, such as `GetTask` and `CancelTask`, are not affected.

## When claude-a2a is ready

claude-a2a runs inside a Claude Code session, so it can't tell whether Claude can answer without asking a model. It learns it from Claude's turns instead. After every turn the person didn't stop, the plugin tells the bridge whether that turn ended with an answer. This covers a task's turns and the person's own.

- **Not ready:** a turn that ended without an answer makes the agent not ready, with the reason `Claude's last turn ended without an answer (<reason>)`.
- **Ready again:** this lasts until a turn ends with an answer, or for 60 seconds, whichever comes first. After the 60 seconds, the next task tries again.

The agent is ready when it starts.
