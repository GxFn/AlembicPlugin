# AlembicPlugin — Alembic Codex Plugin Runtime

This repository builds the **Alembic plugin for Codex**: a lightweight MCP
server that gives Codex local project memory (Recipes, Guard checks, project
knowledge bootstrap) without turning every chat into a setup session. It is
the embedded runtime artifact repository — the root package
(`alembic-codex-plugin-runtime`) is private and is never published to a
registry directly.

[中文](README_CN.md) · End-user install guide: [`plugins/alembic-codex/README.md`](plugins/alembic-codex/README.md)

If you are looking for the full Alembic product (CLI, Dashboard, IDE
integrations), that lives in the main `Alembic` repository and is published as
`alembic-ai` on npm. This repository only owns the Codex plugin runtime.

## Codex 插件

This repository owns the Codex plugin runtime, marketplace shell contract, MCP
tool surface, and local verification flow for Alembic inside Codex. It does not
publish the full Alembic product and it does not add a separate AI provider
runtime; Codex remains the host agent, while this plugin provides local project
memory, bootstrap, Guard, and status tools.

## What runs where

- **MCP server entry**: `bin/codex-mcp.ts`, built to `dist/bin/codex-mcp.js`
  and exposed as the `alembic-codex-mcp` binary. Codex talks to this process
  over MCP; tool calls return clean `structuredContent` (`ok`, `status`,
  `summary`, optional `error` / `meta`, and tool-specific fields). Visible
  tool text is summary-only — hosts must not parse JSON out of text.
- **Startup model**: Codex starts a lightweight shim first; diagnostics and
  workspace status work without initializing the database. Init defaults to
  Ghost mode. The per-workspace daemon (`bin/daemon-server.ts`) is started or
  connected only when project knowledge, Guard, Dashboard handoff, bootstrap,
  or rescan actually need it. The embedded HTTP surface is pinned by
  `CODEX_EMBEDDED_RUNTIME_REQUIRED_ROUTES`
  (`lib/runtime/runtime/EmbeddedRuntimeContract.ts`).
- **Recommended first run inside Codex**: `alembic_status` (add `aspect: runtime`
  for runtime diagnostics) → `alembic_init` (if not initialized) → `alembic_job`
  with `op: bootstrap` for first project knowledge, or `alembic_prime` before
  coding once knowledge exists.

## Delivery chain (marketplace shell → pinned runtime)

1. `.agents/plugins/marketplace.json` is the Codex distribution entry; it points
   at the installable plugin shell.
2. `plugins/alembic-codex/` is the public installable **marketplace shell**
   (submodule → `GxFn/AlembicCodex`). Its MCP config starts
   `bin/alembic-start.mjs`; the shell ships no runtime code.
3. The shell installs the exact pinned npm runtime package
   (`@gxfn/alembic-runtime`, boundary in
   `packages/alembic-runtime/`) into the Alembic startup cache on first
   run and reuses the cache afterwards.

Users install via the Codex plugin marketplace:

```bash
codex plugin marketplace add GxFn/AlembicCodex --ref main
```

Release, version-pin alignment, tagging, and promotion are documented in
[`plugins/alembic-codex/RELEASE-PLAYBOOK.md`](plugins/alembic-codex/RELEASE-PLAYBOOK.md).
How and when `vendor/AlembicCore` is refreshed (and how snapshot lag is
checked) is documented in [`AGENTS.md`](AGENTS.md).

## Development

```bash
npm install
npm run build          # builds @alembic/core source first, then this repo
npm test               # vitest suite
npm run lint           # biome + boundary lints
```

`@alembic/core` resolves from the sibling checkout `../AlembicCore` when
present (local development), otherwise from the `vendor/AlembicCore` snapshot
(`scripts/local-source-paths.mjs`). The vendor snapshot is refreshed by the
release flow, not edited by hand — see the release playbook.

Local Codex iteration:

```bash
npm run dev:codex-plugin:sync       # sync built runtime into the Codex plugin cache
npm run dev:codex-plugin:reload     # reload the plugin in a running Codex
npm run dev:codex-plugin:verify     # verify the synced cache
```

## Verification

```bash
npm run build:check                 # core + plugin type-check
npm run smoke:codex-plugin          # end-to-end plugin smoke (required files, routes, MCP)
npm run verify:codex-plugin         # plugin artifact verification
npm run verify:plugin-distribution  # marketplace/runtime distribution alignment
npm run lint:repo-boundary          # repository boundary lint
npm run release:check               # aggregate release gate
```

## Boundaries and governance

- Repository working rules, window responsibility, and automation gates:
  [`AGENTS.md`](AGENTS.md) (and `CLAUDE.md` for Claude Code hosts).
- Every remaining legacy compatibility path is tracked with an owner and a
  concrete retirement condition in
  [`docs/legacy-register.md`](docs/legacy-register.md).
- Dashboard frontend source, build, and serving belong to
  Alembic/AlembicDashboard — this plugin only performs a daemon handoff.

## Requirements

- Node.js ≥ 22
- better-sqlite3 (bundled)

## License

[MIT](LICENSE) © gaoxuefeng
