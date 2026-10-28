# Contributing

Thank you for wanting to help. This plugin is a personal project with one maintainer, so it moves at that pace, and it stays small on purpose: it speaks A2A for Claude Code, and nothing more.

## Before you start

- **Open an issue first** for anything bigger than a typo, so we can agree on the change before you spend time on it.
- **Read the architecture.** [docs/architecture.md](docs/architecture.md) (arc42, with C4 diagrams) is the authority on how the plugin works. A change to behaviour updates it in the same pull request.
- **Read the [project rules](docs/project-rules.md)**: the commit types and scopes, and how the commits decide the next release.
- **Security reports do not go in issues.** See [SECURITY.md](SECURITY.md).

## Setting up

You need Node 20 or newer and Claude Code.

```
npm install
npm run build
claude --plugin-dir .      # a session with your working copy loaded
```

## Making a change

1. Branch from `main`.
2. Write a test that fails for the right reason, then the code that makes it pass:
   - the wire (transports, auth, the agent card) in `bridge/a2a.test.mjs`, which runs the real bridge end to end
   - the hooks (tools, commands, options) in `tests/register.test.ts`, which runs against the engine
3. Rebuild and commit `dist/a2a.mjs` with any change to `bridge/a2a.mjs`. Installs run no `npm install`, so CI fails when `dist/` does not match the source.
4. Keep these green:
   ```
   node --test bridge/a2a.test.mjs
   claude plugin test .
   npx biome ci .
   claude plugin validate .
   ```
5. Write commit messages in [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) form, one logical change per commit: `fix(server): refuse gRPC calls without the token`. The type decides the next version: `fix` is a patch, `feat` a minor, and a `BREAKING CHANGE:` footer a major. Sign each commit (`git commit -S`) and sign it off (`git commit -s`), which certifies the [Developer Certificate of Origin](https://developercertificate.org). `main` accepts only signed, signed-off commits.
6. For a change to the docs, `npm run docs:serve` shows the site at http://localhost:8000 as it will appear on [fulgas.github.io/claude-a2a](https://fulgas.github.io/claude-a2a/).
7. Open a pull request that says what changed for the person using the plugin, and why.

## Releases

Nobody tags by hand. On every push to `main`, release-please keeps a release pull request open with the next version and its `CHANGELOG.md` entry. Merging it tags `vX.Y.Z` and publishes an immutable GitHub Release.

## Conduct

Everyone taking part follows the [Code of conduct](CODE_OF_CONDUCT.md).
