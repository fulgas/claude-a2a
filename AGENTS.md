# AGENTS.md

Instructions for coding agents working on the a2a plugin. People start with [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md); everything here is also true for them.

## What this is

A Claude Code plugin that speaks the A2A protocol both ways: tools to call remote A2A agents, and `/a2a-serve` to expose a session as an A2A agent whose tasks run as subagents. Two parts:

- `hooks/register.ts`, the hooks module Claude Code runs (TypeScript, no Node, no sockets)
- `bridge/a2a.mjs`, a Node process on `@a2a-js/sdk` that speaks JSON-RPC + SSE, HTTP+JSON and gRPC, bundled into the committed `dist/a2a.mjs`

## Where the truth is

- **`docs/architecture.md`** (arc42, C4) is the authority on what the plugin does and how it is built. Read the section you are touching before changing code.
- **`docs/project-rules.md`** says how changes are made: tests, commit types and scopes, how the commits decide a release. Where it and this file differ, it wins.
- **`.claude-plugin/plugin.json`** holds the options (`userConfig`); the README's options table must match it.

## Commands

| Command | Does |
| --- | --- |
| `npm run build` | Bundles `bridge/a2a.mjs` into `dist/a2a.mjs`. Run after every bridge change and commit the result. |
| `node --test bridge/a2a.test.mjs` | The bridge end to end: real servers and clients on every transport. |
| `claude plugin test .` | The hooks module against the engine (`tests/*.test.ts`). |
| `npx biome ci .` | Format and lint. `npx biome check --write .` fixes what it can. |
| `claude plugin validate .` | The manifest and hooks module as the engine reads them. |
| `npm run docs`, `npm run docs:serve` | Build the documentation site into `docs-site/dist`, or serve it on http://localhost:8000. The site is built from `README.md`, `docs/` and the policies by `docs-site/sync.mjs`; never edit `docs-site/content/`. |

## Code

- **Split by capability.** The hooks module registers tools and commands, spawns subagents and reads their answers. The bridge does everything that needs a socket. Nothing protocol-specific goes in the hooks module.
- **The SDK first.** Protocol behaviour comes from `@a2a-js/sdk`; the bridge only wires it. Read the SDK's types before writing protocol code of our own.
- **KISS, YAGNI.** No abstraction with one implementation, no option for a value nobody changes.
- **Security at the boundary.** The server is loopback-only without a token; the token travels in the environment, never argv; auth is checked on every transport. Do not weaken any of these without an issue that says why.
- **Mermaid** draws the diagrams in `docs/`, and never contains a semicolon: Mermaid reads it as the end of a statement.

## Making a change

1. Read the arc42 section first. A change to what the plugin does changes that section in the same commit.
2. Write the failing test first and watch it fail for the right reason, then make it pass.
3. Run `npm run build` after a bridge change, and keep every command above green.

## Git

- Commit only on a branch, never on `main`. Merging and every push are the user's call.
- Every change reaches `main` through a pull request; the `Test`, `Lint` and DCO checks must pass on a branch up to date with `main`.
- Commits are made as `fulgas <2473927+fulgas@users.noreply.github.com>` and signed with the fulgas key (`33769175F7EF2CCD`); the repository's local git config sets both. Every commit carries the committer's `Signed-off-by:` ([Developer Certificate of Origin](https://developercertificate.org), `git commit -s`).
- Commit messages follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope)!: what changed, for the person using the plugin`, one logical change per commit, and a `BREAKING CHANGE:` footer for anything that breaks a tool, a command or an option. `.githooks/commit-msg` refuses anything else (`git config core.hooksPath .githooks`).
- Releases follow Semantic Versioning from the commits. release-please keeps a release pull request open; merging it tags `vX.Y.Z` and publishes an immutable GitHub Release. Never tag by hand.
- An assistant is credited the way the Linux kernel does it ([AI Coding Assistants](https://docs.kernel.org/process/coding-assistants.html)): an `Assisted-by: AGENT_NAME:MODEL_VERSION [TOOL1] [TOOL2]` trailer, such as `Assisted-by: Claude:claude-opus-5-5`, listing only specialised analysis tools, never git, compilers or editors. An assistant is never a co-author and never signs; the `Signed-off-by:` is the person who commits, who reviews the change and answers for it. No session or conversation links.

## Secrets

Bearer tokens (`A2A_TOKEN`, `A2A_SERVE_TOKEN`, the `token` option) are never printed, logged or committed, and never put on a command line.
