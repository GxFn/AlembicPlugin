# AlembicPlugin — Alembic Codex 插件运行时

本仓库构建 **Alembic 的 Codex 插件**：一个轻量 MCP 服务器，让 Codex 获得本地
项目记忆（Recipes、Guard 检查、项目知识冷启动），而不把每次对话变成安装现场。
这里是嵌入式运行时制品仓库——根包（`alembic-codex-plugin-runtime`）是私有
的，从不直接发布到 registry。

[English](README.md) · 最终用户安装指南：[`plugins/alembic-codex/README.zh-CN.md`](plugins/alembic-codex/README.zh-CN.md)

如果你要找完整的 Alembic 产品（CLI、Dashboard、IDE 集成），它在主仓库
`Alembic` 中维护，以 `alembic-ai` 发布到 npm。本仓库只负责 Codex 插件运行时。

## Codex 插件

本仓库负责 Alembic 在 Codex 内的插件运行时、marketplace 壳契约、MCP 工具面
和本地验证流程。它不发布完整 Alembic 产品，也不引入独立 AI provider runtime；
Codex 仍是宿主 Agent，本插件提供本地项目记忆、bootstrap、Guard 与状态工具。

## 运行结构

- **MCP 服务器入口**：`bin/codex-mcp.ts`，构建为 `dist/bin/codex-mcp.js`，
  以 `alembic-codex-mcp` 命令暴露。工具调用返回干净的 `structuredContent`
  （`ok`、`status`、`summary`、可选 `error` / `meta` 及工具特定字段）；可见
  文本只有 summary，宿主不应从文本中解析 JSON。
- **启动模型**：Codex 先启动轻量 shim；诊断与工作区状态查询不初始化数据库。
  初始化默认 Ghost 模式。仅当项目知识、Guard、Dashboard 交接、bootstrap 或
  rescan 真正需要时才启动/连接每工作区守护进程（`bin/daemon-server.ts`）。
  嵌入式 HTTP 路由面由 `CODEX_EMBEDDED_RUNTIME_REQUIRED_ROUTES`
  （`lib/codex/runtime/EmbeddedRuntimeContract.ts`）钉死。
- **Codex 内推荐首跑**：`alembic_codex_diagnostics` → `alembic_codex_status`
  → 未初始化时 `alembic_codex_init` → 首次建知识用
  `alembic_codex_bootstrap`；已有知识则编码前用 `alembic_intent` +
  `alembic_prime`。

## 分发链（channel → marketplace 壳 → 固定版本运行时）

1. `channels/codex/channel.json` 是 Codex 分发入口，指向 marketplace 清单
   （`.agents/plugins/marketplace.json`）与运行时包版本固定。
2. `plugins/alembic-codex/` 是公开可安装的 **marketplace 壳**（submodule →
   `GxFn/AlembicCodex`）。其 MCP 配置启动 `bin/alembic-codex-start.mjs`；壳
   不携带运行时代码。
3. 壳在首跑时把固定版本的 npm 运行时包（`@gxfn/alembic-runtime`，包
   边界在 `packages/alembic-codex-runtime/`）安装进 Alembic 启动缓存，之后
   复用缓存。

用户通过 Codex 插件 marketplace 安装：

```bash
codex plugin marketplace add GxFn/AlembicCodex --ref main
```

发布、版本对齐、打标与晋级流程见
[`plugins/alembic-codex/RELEASE-PLAYBOOK.md`](plugins/alembic-codex/RELEASE-PLAYBOOK.md)；
`vendor/AlembicCore` 的刷新时机与滞后检查方式见 [`AGENTS.md`](AGENTS.md)。

## 开发

```bash
npm install
npm run build          # 先构建 @alembic/core 源码，再构建本仓库
npm test               # vitest 套件
npm run lint           # biome + 边界 lint
```

`@alembic/core` 优先解析同级检出 `../AlembicCore`（本地开发），否则用
`vendor/AlembicCore` 快照（`scripts/local-source-paths.mjs`）。vendor 快照由
发布流程刷新，不手工编辑——见发布手册。

本地 Codex 迭代：

```bash
npm run dev:codex-plugin:sync       # 同步构建产物到 Codex 插件缓存
npm run dev:codex-plugin:reload     # 在运行中的 Codex 里重载插件
npm run dev:codex-plugin:verify     # 校验已同步缓存
```

## 验证

```bash
npm run build:check                 # core + 插件类型检查
npm run smoke:codex-plugin          # 端到端插件冒烟（必需文件、路由、MCP）
npm run verify:codex-plugin         # 插件制品校验
npm run verify:codex-channel       # channel/marketplace 对齐校验
npm run lint:repo-boundary          # 仓库边界 lint
npm run release:check               # 聚合发布门
```

## 边界与治理

- 仓库工作规则、窗口职责与自动化门：[`AGENTS.md`](AGENTS.md)（Claude Code
  宿主另见 `CLAUDE.md`）。
- 仍存在的遗留兼容路径全部登记在
  [`docs/legacy-register.md`](docs/legacy-register.md)，含 owner 与具体退役
  条件。
- Dashboard 前端源码、构建与服务归属 Alembic/AlembicDashboard——本插件只做
  守护进程交接。

## 环境要求

- Node.js ≥ 22
- better-sqlite3（随包附带）

## License

[MIT](LICENSE) © gaoxuefeng
