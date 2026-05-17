# AlembicPlugin Core Public API Phase 2 Foundation

日期：2026-05-17

来源计划：workspace `docs/alembic-core-public-api-boundary-construction-plan-2026-05-17.md`

## 本阶段范围

Phase 2 在 AlembicPlugin 侧按小批次接入 Core 基础设施稳定入口：

- `@alembic/core/logging`
- `@alembic/core/io`
- `@alembic/core/events`
- `@alembic/core/daemon`
- `@alembic/core/workspace`

本阶段不移动 Codex MCP、tool schema、tool policy、plugin channel、runtime packaging、plugin cache，也不处理 `resources/grammars`。

## 可执行性检查

AlembicPlugin 当前 `vendor/AlembicCore` 指针为 `6358cc7`。该指针已包含 `@alembic/core/daemon` exact export，但尚未包含文档中 Phase 2 提到的 facade 文件和 package exports：

- `@alembic/core/logging`
- `@alembic/core/io`
- `@alembic/core/events`
- `@alembic/core/workspace`
- `@alembic/core/config`

workspace sibling `AlembicCore` 工作区中可以看到这些 facade 文件处于未提交状态；AlembicPlugin 不能引用未提交的 Core 工作树，也不能在本仓库里补 Core 内部 facade。结论是：本轮只执行当前 vendor 已可用的 daemon 批次，其余批次等待 Core 提交并更新 `vendor/AlembicCore` 指针后继续。

## Daemon 批次

替换目标：

| 旧路径 | 新路径 |
| --- | --- |
| `@alembic/core/daemon/DaemonState` | `@alembic/core/daemon` |
| `@alembic/core/daemon/JobStore` | `@alembic/core/daemon` |

替换文件：

- `bin/daemon-server.ts`
- `scripts/smoke-codex-plugin.mjs`
- `lib/codex/KnowledgeState.ts`
- `lib/daemon/DaemonJobRunner.ts`
- `lib/daemon/DaemonSupervisor.ts`
- `lib/external/mcp/CodexMcpServer.ts`
- `lib/http/routes/jobs.ts`
- `lib/injection/ServiceMap.ts`
- `lib/injection/modules/InfraModule.ts`
- `test/support/codex-session/AgentOutputAnalyzer.ts`
- `test/support/codex-session/FakeDaemonSupervisor.ts`
- `test/support/codex-session/ScenarioRunner.ts`
- `test/unit/CodexMcpServer.test.ts`
- `test/unit/CodexStatusService.test.ts`
- `test/unit/DaemonJobRunner.test.ts`
- `test/unit/DaemonSupervisor.test.ts`
- `test/unit/JobsRoute.test.ts`
- `test/unit/JobStore.test.ts`

边界结论：

- `DaemonState`、`JobStore` 是 Core 的 deterministic job/state contract，可以通过 stable daemon entrypoint 使用。
- `DaemonSupervisor`、进程启动、端口选择、健康探测、Codex MCP wrapper 仍属于 AlembicPlugin。
- 本批次没有把 Codex tool schema、MCP envelope 或 plugin cache 迁入 Core。

## 门禁更新

`docs/core-import-boundary-allowlist.json` 已更新：

| 项目 | Phase 1 起始值 | Phase 2 daemon 后 |
| --- | ---: | ---: |
| Core import refs | 906 | 904 |
| unique Core specifiers | 208 | 207 |

allowlist 移除了：

- `@alembic/core/daemon/DaemonState`
- `@alembic/core/daemon/JobStore`

allowlist 新增：

- `@alembic/core/daemon`

## 暂缓批次

以下批次等待 Core facade 进入 `vendor/AlembicCore` 可提交指针后执行：

- logging：`@alembic/core/infrastructure/logging/Logger` -> `@alembic/core/logging`
- io：`@alembic/core/infrastructure/io/WriteZone`、`@alembic/core/shared/PathGuard` -> `@alembic/core/io`
- events：`@alembic/core/infrastructure/signal/SignalBus`、`@alembic/core/shared/TimerRegistry` -> `@alembic/core/events`
- workspace：resolver、project registry、folder names -> `@alembic/core/workspace`

特别保留：

- `WorkspaceSettingsStore` 不切到 workspace facade；它仍包含 AI env/key readiness 逻辑。
- `@alembic/core/config` 本阶段不使用；如果后续发现 Codex/plugin 特定需求，应反馈 Core 拆分。

## 验证

本阶段验证命令：

```bash
npm run lint:core-import-boundary
npm run build:check
```

仓库总 `npm run lint` 当前仍受既有 `lib/agent/**` 与旧脚本诊断影响；本阶段新增和修改文件需单独通过 Biome 检查。
