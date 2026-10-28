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
| `just check` | Everything CI runs. Run before every pull request. |
| `just build` | Bundles `bridge/a2a.mjs` into `dist/a2a.mjs`. Run after every bridge change and commit the result. |
| `just test` | The bridge end to end over every transport (`bridge/a2a.test.mjs`) and the client's authentication (`bridge/auth.test.mjs`), then the hooks module against the engine (`tests/*.test.ts`). |
| `just lint` | Biome, `claude plugin validate .` and zizmor on the workflows. `just fix` applies Biome's fixes. |
| `just audit` | `npm audit` on what ships, and registry signatures and provenance for every package. |
| `just docs`, `just docs-serve` | Build the documentation site into `docs-site/dist`, or serve it on http://localhost:8000. The site is built from `README.md`, `docs/` and the policies by `docs-site/sync.mjs`; never edit `docs-site/content/`. |

## Code

- **Split by capability.** The hooks module registers tools and commands, spawns subagents and reads their answers. The bridge does everything that needs a socket. Nothing protocol-specific goes in the hooks module.
- **The SDK first.** Protocol behaviour comes from `@a2a-js/sdk`; the bridge only wires it. Read the SDK's types before writing protocol code of our own.
- **KISS, YAGNI.** No abstraction with one implementation, no option for a value nobody changes.
- **Security at the boundary.** The server is loopback-only without an API key, an issuer or a client CA; secrets travel in the environment, never argv; credentials are checked on every transport. Do not weaken any of these without an issue that says why.
- **Mermaid** draws the diagrams in `docs/`, and never contains a semicolon: Mermaid reads it as the end of a statement.

## Making a change

1. Read the arc42 section first. A change to what the plugin does changes that section in the same commit.
2. Write the failing test first and watch it fail for the right reason, then make it pass.
3. Run `npm run build` after a bridge change, and keep every command above green.

## Git

- Commit only on a branch, never on `main`. Merging and every push are the user's call.
- Every change reaches `main` through a pull request; the `Test`, `Lint` and DCO checks must pass on a branch up to date with `main`. A pull request is merged with a merge commit: GitHub's rebase rewrites the commits without their signatures, while a merge keeps them as signed and GitHub signs the merge commit itself.
- Every commit is signed with a key GitHub verifies for its author, and carries the committer's Signed-off-by: (Developer Certificate of Origin, git commit -s); main refuses anything else. Contributors sign with their own key.
- Commit messages follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope)!: what changed, for the person using the plugin`, one logical change per commit, and a `BREAKING CHANGE:` footer for anything that breaks a tool, a command or an option. `.githooks/commit-msg` refuses anything else (`git config core.hooksPath .githooks`).
- Releases follow Semantic Versioning from the commits. release-please keeps a release pull request open; merging it tags `vX.Y.Z` and publishes an immutable GitHub Release. Never tag by hand.
- An assistant is credited the way the Linux kernel does it ([AI Coding Assistants](https://docs.kernel.org/process/coding-assistants.html)): an `Assisted-by: AGENT_NAME:MODEL_VERSION [TOOL1] [TOOL2]` trailer, such as `Assisted-by: Claude:claude-opus-5-5`, listing only specialised analysis tools, never git, compilers or editors. An assistant is never a co-author and never signs; the `Signed-off-by:` is the person who commits, who reviews the change and answers for it. No session or conversation links.

## Secrets

Secrets (`A2A_SERVE_API_KEY`, `A2A_API_KEY`, `A2A_TOKEN`, `A2A_OAUTH_CLIENT_SECRET`, `A2A_HTTP_PASSWORD`, `A2A_TOKEN_CACHE`, the private keys the TLS and card signing options name, and the `apiKey`, `clientApiKey`, `clientPassword` and `oauthClientSecret` options) are never printed, logged or committed, and never put on a command line.
