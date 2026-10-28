# Security

Report a vulnerability privately through [GitHub's advisory form](https://github.com/fulgas/claude-a2a/security/advisories/new), not in a public issue. You will get an answer within a week.

Fixes go into the latest release only.

## What counts

The server (`/a2a-serve`) turns every incoming A2A message into a prompt that a Claude Code subagent runs with the session's tools and permissions. In scope:

- a way to reach the server without the configured token, or past the loopback-only default
- a way to make the bridge or the plugin run something other than the subagent the task asked for
- a token leaking into argv, logs, the agent card or a tool result

Out of scope: what a subagent does with a prompt it was legitimately sent. That is governed by your Claude Code permission settings.
