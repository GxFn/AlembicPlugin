# AlembicPlugin Agent Instructions

**重要**：本项目是 Alembic 的 Codex 插件与宿主集成仓库，不是用户项目环境。

Agent 可以制定目标和计划，但目标和计划必须服务于用户提出的真实任务，不能被 Agent 自己偏好的“干净”“薄”“轻量”“空壳”“先搭框架”等路线替换。

Agent 不得把完整实现改成薄实现，不得把成熟能力改成空壳接口，不得把迁移、整理、重构、优化或插件化解释成削减功能。

当 Agent 的计划涉及删减、替换、降级、延期、只做部分、只搭框架、只保留接口、暂不接入或改变完整范围时，必须先向用户确认。

不要在旧工作区或旧克隆路径下工作；当前统一以本 workspace 内的 Alembic 系列仓库为准。

## 仓库定位

- `AlembicPlugin` 负责 Codex 插件、Codex MCP runtime、Codex skills、channel/marketplace 发布、插件 smoke、插件缓存同步、Codex 会话验证和宿主插件集成。
- 共享内核能力通过 `vendor/AlembicCore` 子仓库和 `@alembic/core: file:vendor/AlembicCore` 接入。
- Codex 主 Agent 能力属于宿主环境；本仓库负责把 Codex tool/skill/runtime 与 Alembic Core 能力连接起来。
- Core 需要提供 host-agent workflow/session/briefing/persistence/contract，本仓库保留 Codex tool、MCP、policy、runtime、channel、skill 和发布适配层。
- 不要把插件适配层误删成 Core 内核，也不要把 Codex 插件发布链路迁回 `Alembic` 主仓库。

## Core 接入规则

- `vendor/AlembicCore` 是独立 Git 子仓库，远端应指向 `https://github.com/GxFn/AlembicCore.git`。
- 外层仓库只提交子仓库指针、`package.json` / lockfile 和 Codex 接入代码；Core 内部实现必须在 `AlembicCore` 仓库提交。
- 构建通过 `npm run build:core` 先构建 Core 的 `dist/`，再运行本仓库 TypeScript 构建。
- 不要绕过 `@alembic/core` 包入口直接从 `vendor/AlembicCore/src/**` 引用源码。
- 已迁入 Core 的共享逻辑应通过 `@alembic/core` 子路径导入；Codex MCP、channel、plugin release、marketplace sync、runtime env、tool policy 和 skills 仍属于本仓库。
- 删除本仓库重复实现前，必须确认所有 import 已切到 Core 或 Codex adapter，且对应 build/test/verify 通过。
- AlembicCore 的迁移计划、阶段验收、公开 API 边界、外层接入和删除任务说明，统一查看 workspace 根目录的 `docs/AlembicCore/`。本仓库只执行文档中分配给 `AlembicPlugin` 窗口的 Codex/plugin 接入任务。

## 本仓库必须保留的边界

- `lib/codex/**`：Codex runtime、状态、策略、session、plugin cache 适配。
- `lib/tools/**`、`lib/agent/**`：Codex-facing tools 和宿主集成 glue。
- `plugins/**`、`channels/**`、`.agents/**`、`injectable-skills/**`：插件与 marketplace/channel 交付资源。
- `scripts/*codex*`、`scripts/release-codex-*`、`scripts/sync-codex-*`：Codex 插件同步、验证和发布脚本。
- MCP stdio/http 接入、tool schema、Codex skill 文案、runtime env、dev cache、release packaging。

这些能力不能因为 Core 存在而被移动、空壳化或删除。

## 需要测试时

- `npm run build:check`：包含 Core build 和本仓库 no-emit 检查。
- `npm run build`：构建 Core 和本仓库。
- `npm run test` / `npm run test:unit` / `npm run test:integration` / `npm run test:e2e`：按改动范围选择。
- `npm run lint`：Biome 检查。
- `npm run lint:repo-boundary`：仓库边界扫描。
- Codex 插件链路改动必须按范围运行：
  - `npm run smoke:codex-plugin`
  - `npm run verify:codex-plugin`
  - `npm run verify:codex-channel`
  - `npm run verify:codex-session`
- 本地插件同步/调试常用：
  - `npm run dev:codex-plugin:sync`
  - `npm run dev:codex-plugin:local-mcp`
  - `npm run dev:codex-plugin:verify`
  - `npm run dev:codex-plugin:watch`
- 不要在 AlembicPlugin 仓库内冒充用户项目执行真实用户命令。

## 文件存放约定

- 正式源码：`lib/`、`bin/`、`config/`。
- 正式脚本：`scripts/`。
- 正式文档：`docs/`。
- 开发临时文档：`docs-dev/`（不跟随 git）。
- 临时测试脚本：`scratch/`（不跟随 git）。
- 插件资源：`plugins/`、`channels/`、`.agents/`、`injectable-skills/`。
- Dashboard：`dashboard/`。
- Core 子仓库：`vendor/AlembicCore`。
- workspace 级 AlembicPlugin 接入和协作文档：workspace 根目录的 `docs/AlembicPlugin/`；Core 迁移手册和边界文档查看 `docs/AlembicCore/`。

当前主要源码分层：

```text
lib/
├── agent
├── cli
├── codex
├── core
├── daemon
├── domain
├── external
├── http
├── infrastructure
├── injection
├── repository
├── service
├── shared
├── tools
├── types
└── workflows
```

## 技术栈与编码约定

- 语言：TypeScript (ES2024, NodeNext)，Node.js >= 22。
- 模块系统：ESM (`"type": "module"`)，import 路径必须带 `.js` 后缀。
- 路径别名定义在 `package.json` imports 字段，包括 `#shared/*`、`#infra/*`、`#service/*`、`#agent/*`、`#inject/*`、`#core/*`、`#external/*`、`#http/*`、`#workflows/*`、`#tools/*`、`#codex/*`。
- Lint / Format：Biome 2.x，不使用 Prettier/ESLint。
- 测试框架：Vitest。
- Dashboard：React + Vite。
- MCP/Codex tool 返回结构必须保持明确 schema 和向后兼容。
- 可以使用中文注释解释 Codex 边界、插件交付约束、复杂状态机或兼容原因；不要给自解释代码堆注释。

## 类型安全与代码规则

- `catch` 块使用 `catch (err: unknown)` + 类型守卫，禁止 `catch (err: any)`。
- Dashboard 错误处理优先使用 `dashboard/src/utils/error.ts` 的工具函数。
- 避免 `as any`；不得已时加注释说明原因。
- `throw` 只能抛出 `Error` 实例。
- if/else/for/while 必须使用花括号。
- 不要回退其他窗口或用户已有改动；如果工作区已有无关变更，只处理当前任务需要的文件。

## 长期维护规则

- 改 Core 接入前先确认 Core exports 和 Codex adapter 边界。
- 改 MCP、tool、skill、plugin runtime、channel 或 marketplace 时，默认这是本仓库职责，不要强行迁入 Core。
- 删除旧实现必须先有扫描、替代入口、测试和可解释的提交。
- 如果需要同步 Core，先在 `AlembicCore` 提交，再更新 `vendor/AlembicCore` 指针并运行本仓库验证。
