# AlembicPlugin

AlembicPlugin is the unified plugin repository for Alembic host integrations.

This repository currently carries the Codex plugin runtime and development
tooling migrated from `GxFn/Alembic`. Future host integrations should be added
as plugin submodules under `plugins/`, rather than being mixed into the core
runtime repository.

## Repository Model

- Root repository: shared plugin tooling, channel metadata, release checks, and
  integration verification.
- `plugins/alembic-codex`: Codex plugin submodule.
- Future plugins: add as `plugins/<host-or-plugin-name>` submodules.

Clone with submodules:

```bash
git clone --recurse-submodules https://github.com/GxFn/AlembicPlugin.git
```

Update submodules:

```bash
git submodule update --init --recursive
```

Nested submodules are supported. If a plugin submodule later owns its own
submodules, the recursive update command will initialize those too.

## Codex 插件

The current Codex plugin remains at `plugins/alembic-codex`. The root runtime
keeps the current Alembic Codex MCP implementation while the project is being
split into:

- `GxFn/AlembicPlugin`: plugin integration repository.
- `GxFn/Alembic`: standalone full-capability local product.
- `GxFn/AlembicCore`: shared core runtime, extracted after the plugin and local
  product boundaries are stable.

Detailed release, test, and promotion steps are maintained in
`plugins/alembic-codex/RELEASE-PLAYBOOK.md`.

Recommended verification:

```bash
npm run build
npm run build:dashboard
npm run prepare:codex-plugin-runtime
npm run verify:codex-channel
npm run verify:codex-plugin
npm run smoke:codex-plugin
```

Release checks:

```bash
npm run release:codex-plugin
npm run release:codex-plugin:daemon
```
