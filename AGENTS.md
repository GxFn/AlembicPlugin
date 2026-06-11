# AlembicPlugin Agent Instructions

<!-- wakeflow:scope:start -->
## Workspace Access Card

This section is maintained by the Wakeflow runtime installer. It records this window access coordinates and the minimum automation gate. Hard rules come from the parent AGENTS and this file; do not duplicate repository-specific rules here.

### Coordinates

- Wakeflow runtime: `..`
- Window name: `AlembicPlugin`
- Parent workspace AGENTS: `../AGENTS.md`
- Active workspace index: `../.workspace-active/workspace/index.md`
- Active workspace status: `../.workspace-active/workspace/current/workspace-current-status.md`
- Current plan directory: `../.workspace-active/workspace/current`
- Window ledger: `../wakeflow-ledger/AlembicPlugin`

### When claiming workspace work

1. Read this file first.
2. Then read parent `../AGENTS.md`.
3. Then read `../.workspace-active/workspace/index.md` and `../.workspace-active/workspace/current/workspace-current-status.md`.
4. If there is a current plan, task package, or direct-thread delivery, execute only the content under `../.workspace-active/workspace/current` explicitly assigned to `AlembicPlugin`.
5. Goals, scope, forbidden actions, validation commands, and backfill fields come from the current plan, task package, and repository rules. Prompts are only wakeup entrypoints, not the full task specification.

### Direct Thread Dispatch Minimum Gate

- Direct-thread delivery is the normal work transport. It does not change this window responsibility or expand task scope. Specific work comes from the dispatch packet, current plan, and repository rules.
- Delivery prompts carry only a few dynamic variables and a skill pointer. Do not treat the prompt as a full command manual. State-machine routes need only visible `currentWindow` / `taskId` / `stateRoot` / optional `dispatchGroup`. Machine fields such as `controllerWindow`, `returnPolicy`, `humanContextRef`, and `stateRevision` are read from the state root, dispatch group, and delivery envelope. Stop and report if `stateRoot` is missing or variables conflict.
- This window only handles dispatch packets for `AlembicPlugin` and returns `TargetResultEnvelope`. Do not claim, accept, or process other window tasks.
- Child windows do not create target-to-target next-hop delivery by default. Evidence repair, redispatch, and next phases are decided by controller review. If delivery has `returnRoute=controller` and `review-results` shows that `DispatchGroup.returnPolicy` allows a callback, create exactly one controller-return envelope with `build-controller-return`, returning by default to the original controller named by `DispatchGroup.controllerWindow`. Then complete the real direct-thread send, readback, and `record-delivery-run`. A controller return is complete only when a `DirectThreadDeliveryRun` exists with `status=sent` and `readback.ok=true`. The full group snapshot stays in the controller-return envelope; the visible prompt shows only non-empty exceptional targets and must not treat one target backfill as whole-group completion.
- Non-Test windows must not create, process, or verify Test delivery unless both the current plan and delivery envelope explicitly authorize it.
- Thread ids may only be written to Wakeflow local runtime. Do not write them to tracked documents, backfill text, or GitHub.

### Document Destinations

- Long-term cross-repository collaboration docs, plans, acceptance records, scans, and boundary records go to `../wakeflow-ledger/AlembicPlugin`. This repository `docs/` is only for product, release, or user docs maintained with the source.
<!-- wakeflow:scope:end -->

## 本窗口最高停止卡

本项目是 Alembic 的 Codex 插件与宿主集成仓库，不是用户项目环境。以下规则是本窗口执行前停止卡；任何任务、自动化、脚本输出或当前计划与本节冲突时，先停止并回报总控。

### 先停下

- 如果当前任务没有明确分配给 `AlembicPlugin`，或目标不是 Codex MCP、skill、channel/marketplace、插件 runtime、安装验证、Codex host adaptation，停止。
- 如果我准备把完整插件能力改成薄实现、空壳接口、静态 mock、无真实 host 调用、无 MCP schema、无 channel / marketplace 验证或无 Codex 会话证据，停止。
- 如果我准备把迁移、整理、重构、优化或插件化解释成删减功能，或把用户目标替换成“干净”“薄”“轻量”“空壳”“先搭框架”，停止。
- 如果我准备重新引入独立 Agent runtime、AI provider runtime 或 Agent Tool V2 runtime，包括 `@alembic/agent`、`#agent/*`、`#tools/*`、`#external/ai/*`、`lib/agent/**`、`lib/tools/**`、`lib/external/ai/**`，但用户和总控文档没有明确改变边界，停止。
- 如果我准备把 Codex 插件发布链路迁回 `Alembic` 主仓库，或把插件适配层误删成 Core 内核，停止。
- 如果共享能力可以通过 `../AlembicCore` / `@alembic/core` 消费，却准备绕过包入口引用 Core 源码、复制 Core 实现或把 Core 实现写进本仓库，停止。
- 如果下一跳或回填涉及 `AlembicTest`，但当前计划和 delivery envelope 没有同时显式授权本窗口处理 TestWindow heartbeat，停止。
- 如果计划涉及删减、替换、降级、延期、只做部分、只搭框架、只保留接口、暂不接入或改变完整范围，停止并回到用户或总控确认。
- 如果准备修改相邻仓库、更新 Core 子仓库指针、发布 channel、同步 marketplace、清理缓存或改变安装路径，但当前任务没有明确授权，停止。
- 如果无法提供提交 hash 或 no-commit 理由、验证命令、验证结果、插件 / channel / session 证据、遗留风险和下一步建议，不得回填完成。

### 正确顺序

1. 先确认任务属于 `AlembicPlugin` 的 Codex host / plugin 边界。
2. 再读取 Core exports、Codex adapter、MCP schema、skill / channel / runtime 入口和当前计划证据。
3. 再实现或修复真实插件链路，保留真实 host 调用、状态变化和可复核证据。
4. 最后运行对应 build / boundary / plugin / channel / session 验证，并按总控要求回填。

## 职责边界

- `AlembicPlugin` 负责 Codex 插件、Codex MCP runtime、Codex skills、channel/marketplace 发布、插件 smoke、插件缓存同步、Codex 会话验证和宿主插件集成。
- 共享内核能力在本 workspace 日常开发中优先通过 `../AlembicCore` 和 `@alembic/core: file:../AlembicCore` 接入；`vendor/AlembicCore` 只作为 workspace 外 fallback、release snapshot 或 Codex portable runtime 快照来源/目标。
- Codex 主 Agent 能力属于宿主环境；本仓库负责把 Codex MCP tool/skill/runtime 与 Alembic Core 能力连接起来。
- Core 需要提供可复用 workflow/session/briefing/persistence/contract，本仓库保留 Codex MCP tool schema、policy、runtime、channel、skill 和发布适配层。
- 不要在旧工作区或旧克隆路径下工作；当前统一以本 workspace 内的 Alembic 系列仓库为准。

## Core 接入规则

- `../AlembicCore` 是本 workspace 的 Core 源仓库，是开发、build、check 和 boundary lint 的默认入口。
- `vendor/AlembicCore` 是独立 Git 子仓库，远端应指向 `https://github.com/GxFn/AlembicCore.git`；只在 workspace 外 fallback、release snapshot 或 portable runtime 场景使用。
- 外层仓库只提交子仓库指针、`package.json` / lockfile 和 Codex 接入代码；Core 内部实现必须在 `AlembicCore` 仓库提交。
- 构建通过 `npm run build:core` 先构建 Core 的 `dist/`，再运行本仓库 TypeScript 构建。
- 不要绕过 `@alembic/core` 包入口直接从 `../AlembicCore/src/**` 或 `vendor/AlembicCore/src/**` 引用源码。
- 已迁入 Core 的共享逻辑应通过 `@alembic/core` 子路径导入；Codex MCP、channel、plugin release、marketplace sync、runtime env、tool policy 和 skills 仍属于本仓库。
- 删除本仓库重复实现前，必须确认所有 import 已切到 Core 或 Codex adapter，且对应 build/test/verify 通过。

## 插件保留边界

- `lib/codex/**`：Codex runtime、状态、策略、session、plugin cache 适配。
- `lib/codex/mcp/**`：Codex MCP tool 声明、schema、annotation、gateway 映射和 stdio/http glue。
- `plugins/**`、`channels/**`、`.agents/**`、`injectable-skills/**`：插件与 marketplace/channel 交付资源。
- `scripts/*codex*`、`scripts/release-codex-*`、`scripts/sync-codex-*`：Codex 插件同步、验证和发布脚本。
- MCP stdio/http 接入、tool schema、Codex skill 文案、runtime env、dev cache、release packaging。
- `scripts/report-agent-extraction-boundary.mjs` 可保留旧 `lib/agent/`、`lib/tools/`、`lib/external/ai/` 字符串作为删除边界审计标签；这些标签不得被解释为允许恢复本地 Agent/Tool/AI runtime。

这些能力不能因为 Core 存在而被移动、空壳化或删除。

## 验证与回填

- `npm run build:check`：包含 Core build 和本仓库 no-emit 检查。
- `npm run build`：构建 Core 和本仓库。
- `npm run test` / `npm run test:unit` / `npm run test:integration` / `npm run test:e2e`：按改动范围选择。
- `npm run lint`：Biome 检查。
- `npm run lint:repo-boundary`：仓库边界扫描。
- `npm run report:agent-extraction-boundary`：Agent / AI / Tool 删除边界报告，涉及 agent-free 改动时必须运行。
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

## 文件地图

- 正式源码：`lib/`、`bin/`、`config/`。
- 正式脚本：`scripts/`。
- 正式文档：`docs/`；仓库内 `docs/` 仅放随源码长期维护的产品/发布文档，跨仓库迁移和验收文档写入 `../workspace-ledger/AlembicPlugin/`。
- 开发临时文档：`docs-dev/`（不跟随 git）。
- 临时测试脚本：`scratch/`（不跟随 git）。保留规则：已完成需求的
  `afapi-*` 验收/探针产物由 `scripts/clean-scratch.mjs` 回收（默认 dry-run，
  默认保留 7 天，`--apply` 仅在受监督场景使用）；被 workspace ledger 验收记录
  引用的产物登记在脚本内白名单中，禁止删除；非 `afapi-*` 条目不在脚本范围内。
- 插件资源：`plugins/`、`channels/`、`.agents/`、`injectable-skills/`。
- Dashboard 前端已迁出到 `AlembicDashboard`，不要在本仓库新增 Dashboard 源码。
- Core 本地源仓库：`../AlembicCore`。
- Core portable snapshot / fallback 子仓库：`vendor/AlembicCore`。
- workspace 级长期协作文档按 Workspace 接入卡中的 `Window ledger` 归档。

当前主要源码分层：

```text
lib/
├── cli
├── codex
│   └── mcp
├── daemon
├── governance
├── http
├── infrastructure
├── injection
├── repository
├── service
├── shared
├── types
└── workflows
```

## 技术与代码规则

- 语言：TypeScript (ES2024, NodeNext)，Node.js >= 22。
- 模块系统：ESM (`"type": "module"`)，import 路径必须带 `.js` 后缀。
- 路径别名定义在 `package.json` imports 字段，包括 `#shared/*`、`#infra/*`、`#service/*`、`#inject/*`、`#governance/*`、`#http/*`、`#workflows/*`、`#codex/*`。
- Lint / Format：Biome 2.x，不使用 Prettier/ESLint。
- 测试框架：Vitest。
- Dashboard 前端已迁出到 `AlembicDashboard`。
- MCP/Codex tool 返回结构必须保持明确 schema 和向后兼容。
- 必须尽量多地在代码旁补充简体中文说明，优先解释 Codex 边界、插件交付约束、复杂状态机、分叉原因、降级原因、兼容路径、宿主差异和后续校验方式。
- 任何运行时分叉、fallback、降级、兼容转译、跳过、短路、重试、取消或错误归类，都必须打印足够明确的日志或诊断事件，日志要能看出触发条件、选择路径、关键输入、结果状态和后续校验依据。

- `catch` 块使用 `catch (err: unknown)` + 类型守卫，禁止 `catch (err: any)`。
- Dashboard 前端问题在 `AlembicDashboard` 仓库处理；本仓库不新增或修改 Dashboard 源码。
- 避免 `as any`；不得已时在附近说明原因。
- `throw` 只能抛出 `Error` 实例。
- if/else/for/while 必须使用花括号。
- 不要回退其他窗口或用户已有改动；如果工作区已有无关变更，只处理当前任务需要的文件。

## 长期维护规则

- 改 Core 接入前先确认 Core exports 和 Codex adapter 边界。
- 改 MCP、tool、skill、plugin runtime、channel 或 marketplace 时，默认这是本仓库职责，不要强行迁入 Core。
- 删除旧实现必须先有扫描、替代入口、测试和可解释的提交。
- 如果需要同步 Core 开发能力，先在 workspace `../AlembicCore` 提交并由本仓库通过 `file:../AlembicCore` 验证；只有 release、Codex portable runtime、离线安装、远程 CI 或 workspace 外 fallback 需要时，才更新 `vendor/AlembicCore` 指针并记录源 commit。

### vendor/AlembicCore 快照刷新流程

`vendor/AlembicCore` 是固定在精确 Core commit 上的 git submodule，仅作为
portable/fallback Core 源：本地开发始终优先解析同级 `../AlembicCore`
（`scripts/local-source-paths.mjs` 先找 `../AlembicCore` 再找
`vendor/AlembicCore`），已发布运行时包消费的是 registry 上的
`@alembic/core` 版本而非快照。因此快照落后 Core HEAD 是预期内、可解释的
状态，不是异常。

- **何时刷新（发布步骤）**：在 `plugins/alembic-codex/RELEASE-PLAYBOOK.md`
  Version And Tag Flow 第 2 步（更新包元数据）期间，且仅当本次发布需要
  快照固定点之后落地的 Core 变更（portable runtime / 离线安装 / 远程 CI
  构建，或 state root 显式要求）。不消费新 Core 行为的常规插件发布保持
  现有固定点。禁止直接编辑 `vendor/AlembicCore` 内文件；Core 变更先在
  AlembicCore 仓库提交，再移动固定点：
  `git -C vendor/AlembicCore fetch origin && git -C vendor/AlembicCore
  checkout <released-core-commit>`，然后 `git add vendor/AlembicCore` 随
  发布准备一起提交 gitlink。
- **如何检查滞后（每次发布决策前）**：
  `git -C ../AlembicCore rev-list --count "$(git -C vendor/AlembicCore
  rev-parse HEAD)"..HEAD` 得到快照落后的 Core commit 数；有意保持固定点
  时把该滞后数记入发布说明，让下次发布能区分「已解释的滞后」与「忘了
  同步」。
