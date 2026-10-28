# The a2a plugin for Claude Code. `just` lists the recipes; `just check` runs everything CI runs.

# List the recipes.
default:
    @just --list

# Install the dependencies, and turn on the commit message check once per clone.
setup:
    npm ci
    git config core.hooksPath .githooks

# Bundle bridge/a2a.mjs into dist/a2a.mjs; commit the result with every bridge change.
build:
    npm run build

# Every test: the bridge end to end over every transport, then the hooks module against the engine.
test: build
    node --test bridge/*.test.mjs
    claude plugin test .

# Format and lint check, the plugin as the engine reads it, and the workflows' security audit.
lint:
    npx biome ci .
    claude plugin validate .
    uvx zizmor --offline .github/workflows

# Apply Biome's formatting and safe fixes.
fix:
    npx biome check --write .

# Known vulnerabilities in what ships, and registry signatures and provenance for every package.
audit:
    npm audit --omit=dev --audit-level=moderate
    npm audit signatures

# Build the documentation site into docs-site/dist.
docs:
    npm run docs

# Serve the documentation site on http://localhost:8000 with live reload; re-run after editing the Markdown.
docs-serve:
    npm run docs:serve

# Everything CI checks, before a pull request.
check: lint test audit docs
    git diff --exit-code dist/

# A Claude Code session with this working copy loaded as a plugin.
try:
    claude --plugin-dir .
