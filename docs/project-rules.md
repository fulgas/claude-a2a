# Project rules

How changes to the a2a plugin are made. What the plugin does and how it is built is in the [architecture](architecture.md); [section 9](architecture.md#9-architecture-decisions) says why.

## The architecture comes first

- [docs/architecture.md](architecture.md), in arc42 sections, is the authority. Read the section you are touching before changing code.
- A change to what the plugin does changes its section in the same pull request, before or with the code.
- A decision that would surprise the next reader gets a row in [section 9](architecture.md#9-architecture-decisions): what was decided, why, and what was rejected. A replaced decision keeps its row, marked superseded.
- The C4 views in [section 5](architecture.md#5-building-block-view) change with the building blocks they draw. They are Mermaid flowcharts in C4 notation, and contain no semicolon: Mermaid reads it as the end of a statement.

## Principles

- **Split by capability.** The hooks module (`hooks/register.ts`) registers tools and commands, puts tasks into the conversation or spawns subagents, and reads their answers. The bridge (`bridge/a2a.mjs`) does everything that needs a socket. Nothing protocol-specific goes in the hooks module.
- **The SDK first.** Protocol behaviour comes from `@a2a-js/sdk`; the bridge only wires it.
- **KISS and YAGNI.** The simplest thing that meets the documentation, and nothing for a future that has not been asked for. No abstraction with one implementation, no option for a value nobody changes.
- **Safe by default.** The server is loopback-only without an API key, an issuer or a client CA, secrets never reach argv or a log, and every transport checks the credentials. Weakening any of these needs an issue that says why.

## Test first

- A change starts with a test that fails for the right reason, then the code that makes it pass.
- The wire (transports, auth, the agent card) is tested end to end in `bridge/a2a.test.mjs`, against the real bridge, and the client's authentication against a stand-in identity provider in `bridge/auth.test.mjs`. The hooks (tools, commands, options) are tested in `tests/register.test.ts`, against the engine.
- `just check` stays green: `just test`, `just lint` (Biome, `claude plugin validate`, zizmor), `just audit` and `just docs`, the same checks CI runs.
- `dist/a2a.mjs` is rebuilt (`just build`) and committed with every change to the bridge. Installs run no `npm install`, so CI fails when `dist/` does not match the source.

## Conventional Commits

Commit messages follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```text
type(optional-scope)!: what changed, for the person using the plugin

Optional body: why, and what it affects.

BREAKING CHANGE: what no longer works, and what to do instead
```

The subject says what changed in plain words (`fix(server): refuse gRPC calls without the token`), not which file was edited. The `!` and the `BREAKING CHANGE:` footer mark a change that breaks a tool, a command, an option or the wire; a breaking change always has the footer.

| Type | Use |
| --- | --- |
| `feat` | Something new people can use. |
| `fix` | A defect corrected, or a dependency update that ships (`fix(deps)`). |
| `perf` | Faster or lighter, same behaviour. |
| `docs` | Documentation only: the architecture, these rules, the README, the docs site. |
| `test` | Tests only, no change in behaviour. |
| `refactor` | Code reshaped with no change in behaviour. |
| `build`, `ci`, `chore`, `style`, `revert` | Build, automation, upkeep, formatting, undoing earlier work. |

Scopes, when they help: `client`, `server`, `bridge`, `plugin`, `config`, `deps`, `release`, `lint`, `docs-site`. One logical change per commit.

`.githooks/commit-msg` refuses any other message; turn it on once per clone with `git config core.hooksPath .githooks`. Every change reaches `main` through a pull request, where `Test`, `Lint` and the DCO check must pass on a branch up to date with `main`. A pull request is merged with a merge commit: GitHub's rebase rewrites the commits without their signatures, while a merge keeps them as signed and GitHub signs the merge commit itself. Every commit is signed (`git commit -S`) and signed off (`git commit -s`): the `Signed-off-by:` line certifies the [Developer Certificate of Origin](https://developercertificate.org).

## Releases

Releases follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html), and the commits decide the number. Since the last release:

| The commits include | The next version |
| --- | --- |
| a `BREAKING CHANGE:` footer or a `!` after the type | major (while the version is 0.x, minor) |
| a `feat` | minor (while the version is 0.x, still minor) |
| only `fix` (including `fix(deps)`), `perf` or `revert` | patch |
| nothing else (`docs`, `test`, `refactor`, `build`, `ci`, `chore`, `style`) | no release |

A release comes through a pull request. On every push to `main`, release-please (configured in `release-please-config.json`) keeps one pull request open, titled `chore(release): vX.Y.Z`. It sets the version in `package.json` and `.claude-plugin/plugin.json` and adds the release to `CHANGELOG.md`, its notes made from the commit subjects. The agent card reads its version from `package.json` at run time, so a release changes no code. Merging the pull request is the release: the release app tags `vX.Y.Z` on `main` and publishes the GitHub Release (`release.yml`). Releases are immutable: once published, a release and its tag name can never change or be used again. Nobody tags by hand.

Renovate types its updates by what they change. Updates to the bridge's dependencies are bundled into `dist/a2a.mjs`, so they ship: `fix(deps)`, a patch release, and the pull request needs `npm run build` committed before CI passes. Build and lint tools are `chore(deps)`, and GitHub Actions and the Claude Code version CI tests against are `ci(deps)`. None of these three makes a release.

## Secrets

- Secrets (API keys, OAuth client secrets and bearer tokens: `A2A_SERVE_API_KEY`, `A2A_API_KEY`, `A2A_TOKEN`, `A2A_OAUTH_CLIENT_SECRET`, and the `apiKey`, `clientApiKey` and `oauthClientSecret` options) are never printed, logged, committed or put on a command line.
- Issues and pull requests never carry a token: the bug template asks for them to be removed from pasted output.
