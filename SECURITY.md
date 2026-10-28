# Security

Report a vulnerability privately through [GitHub's advisory form](https://github.com/fulgas/claude-a2a/security/advisories/new), not in a public issue. You will get an answer within a week.

Fixes go into the latest release only.

## What counts

The server (`/a2a-serve`) turns every incoming A2A message into a prompt that Claude Code runs with the session's tools and permissions: in the conversation itself by default, or in a subagent. In scope:

- a way to reach the server without a valid API key or JWT, or past the loopback-only default
- a JWT the server accepts although its signature, issuer, audience or expiry is wrong
- a way past the failed sign-in limit, or to start tasks past the task limits
- a way to make the bridge or the plugin run something other than the prompt the task asked for
- an API key, OAuth client secret or token leaking into argv, logs, the agent card or a tool result

Out of scope: what Claude does with a prompt it was legitimately sent. That is governed by your Claude Code permission settings.

## Verifying a release

Releases are immutable, and each one carries two signed attestations you can check with the [GitHub CLI](https://cli.github.com):

```
# The release and its tag are the ones GitHub published
gh release verify v0.1.0 --repo fulgas/claude-a2a

# The files the plugin runs were built from that tag by this repository's release workflow (SLSA build provenance)
gh attestation verify dist/a2a.mjs --repo fulgas/claude-a2a
gh attestation verify hooks/register.ts --repo fulgas/claude-a2a
```

Run the second pair from a checkout of the tag, or from the plugin's installed folder.
