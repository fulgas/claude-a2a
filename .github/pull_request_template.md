## What changes, for the person using the plugin

<!-- One logical change. Link issues with "Fixes #123". -->

## Checklist

- [ ] The docs this touches (README, `docs/`) say what the change does
- [ ] A failing test came first: `bridge/a2a.test.mjs` for the wire, `tests/` for the hooks
- [ ] `just build` was run and `dist/` is committed with the change
- [ ] `just check` passes
- [ ] Every commit is a signed, signed-off ([DCO](https://developercertificate.org/)) [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/), with a `BREAKING CHANGE:` footer when it breaks a tool, a command or a setting
