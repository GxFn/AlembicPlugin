# AlembicPlugin

AlembicPlugin is the Codex plugin repository for Alembic host integration.

This repository carries the Codex plugin runtime and development tooling
migrated from `GxFn/Alembic`. It does not publish a root npm registry package
and does not maintain non-Codex host plugin delivery paths.

## Repository Model

- Root repository: shared plugin tooling, channel metadata, release checks, and
  integration verification.
- `plugins/alembic-codex`: Codex plugin submodule.

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

The Codex plugin remains at `plugins/alembic-codex`. The root runtime keeps the
Alembic Codex MCP implementation while the project is split into:

- `GxFn/AlembicPlugin`: plugin integration repository.
- `GxFn/Alembic`: standalone full-capability local product.
- `GxFn/AlembicCore`: shared core runtime, extracted after the plugin and local
  product boundaries are stable.

Detailed release, test, and promotion steps are maintained in
`plugins/alembic-codex/RELEASE-PLAYBOOK.md`.

Recommended verification:

```bash
npm run build
npm run prepare:codex-plugin-runtime
npm run verify:codex-channel
npm run verify:codex-plugin
npm run smoke:codex-plugin
```

Dashboard frontend source, build, and serving live outside this repository.
The Codex plugin only hands off a Dashboard URL when a local Alembic daemon
already advertises that capability.

Release checks:

```bash
npm run release:codex-plugin
npm run release:codex-plugin:daemon
```
