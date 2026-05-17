# Core Public API Phase 4 Plugin Database / Repository 接入记录

日期：2026-05-17
范围：AlembicPlugin 仓库
依据：workspace `docs/alembic-core-public-api-boundary-construction-plan-2026-05-17.md` Phase 4

## 目标

本阶段只处理 AlembicPlugin 对 Core database / repository 边界的接入，不移动 Codex MCP、tool schema、channel delivery、AI provider、API key、AgentRuntime 等插件职责。

Phase 4 的目标是让新增或修改代码优先使用：

- `@alembic/core/database`
- `@alembic/core/repositories`

同时把仍需直连 Drizzle schema 或 repository impl 的位置记录为迁移期事实，而不是静默保留。

## Core 版本

`vendor/AlembicCore` 已前进到 `7231909`，包含 Core 侧 Phase 4 facade：

- `@alembic/core/database`
- `@alembic/core/repositories`
- `createAlembicRepositories(database)`
- Core database/repository public API contract test

## 完成批次

### Database 类型入口

以下位置不再从 `@alembic/core/infrastructure/database/DatabaseConnection` 或 runtime db 深路径获取 database 类型，改走 `@alembic/core/database`：

- `lib/bootstrap.ts`
- `lib/types/database.ts`
- `lib/infrastructure/cache/CacheCoordinator.ts`
- `lib/infrastructure/audit/AuditStore.ts`
- `lib/agent/memory/MemoryStore.ts`
- `lib/injection/ServiceContainer.ts`
- `lib/injection/ServiceMap.ts`
- `lib/injection/modules/VectorModule.ts`
- `test/unit/AuditLogger.test.ts`
- `test/unit/Gateway.test.ts`

`Bootstrap.initializeDatabase()` 的工作流未改，只替换 import 和类型来源。

### Repository factory 装配

`lib/injection/modules/InfraModule.ts` 已用 `createAlembicRepositories(ct.get('database'))` 统一装配 Core-owned repositories，并缓存到 `ct.singletons.coreRepositories`。

当前改走 Core factory 的服务 key：

- `knowledgeRepository`
- `knowledgeEdgeRepository`
- `codeEntityRepository`
- `bootstrapRepository`
- `guardViolationRepository`
- `sessionRepository`
- `proposalRepository`
- `warningRepository`
- `lifecycleEventRepository`
- `recipeSourceRefRepository`

继续留在 Plugin 的仓储：

- `auditRepository`：Plugin audit 边界，仍使用外层 `AuditRepositoryImpl`。
- `memoryRepository`：Agent semantic memory，Phase 4 明确不进入 Core stable factory。
- `tokenUsageStore`：AI/provider telemetry，Phase 4 明确不进入 Core stable factory。

### Repository 类型入口

以下调用方的 Core repository 类型已改从 `@alembic/core/repositories` 获取：

- `lib/injection/ServiceMap.ts`
- `lib/injection/modules/KnowledgeModule.ts`
- `lib/injection/modules/GuardModule.ts`
- `lib/injection/modules/PanoramaModule.ts`
- `lib/http/routes/evolution.ts`
- `lib/service/evolution/FileChangeHandler.ts`
- `lib/external/mcp/handlers/rescan/InternalKnowledgeRescanWorkflow.ts`

业务逻辑未改，只替换 repository 类型来源和 DI 获取处的类型 cast。

## 直接 schema / impl 残留审计

### Plugin-owned audit

保留：

- `lib/infrastructure/audit/AuditStore.ts`
- `lib/repository/audit/AuditRepository.ts`

表级需求：

- `auditLogs`
- 记录插件运行审计、查询审计历史、统计审计事件。

判断：

这部分仍属于 Plugin audit 边界。Core 尚未确认 audit repository 是否为 shared stable capability，因此 Phase 4 不删除、不迁移。

### Agent semantic memory

保留：

- `lib/agent/memory/MemoryStore.ts`

表级需求：

- `semanticMemories`
- Agent 语义记忆读写。

判断：

`memoryRepository` 和 semantic memory 属于后续 Agent/AI memory 边界，不属于 Phase 4 repository factory 稳定范围。

### Search / sync / token adapter

保留：

- `lib/bootstrap.ts`
- `lib/cli/KnowledgeSyncService.ts`
- `lib/injection/modules/AppModule.ts`
- `lib/injection/ServiceContainer.ts`
- `lib/injection/modules/GuardModule.ts`
- `lib/service/signal/HitRecorder.ts`
- `lib/agent/memory/PersistentMemory.ts`

需求：

- `unwrapRawDb`
- `RawDbSyncAdapter`
- `TokenUsageStore`

判断：

这些属于 Phase 5 Search / Vector / Guard 或 AI telemetry 边界，不在 Phase 4 中强行收敛。

### 测试与 fixture 兼容

保留：

- `test/integration/DrizzleORM.test.ts`
- `test/unit/ProposalRepository.test.ts`
- `test/unit/ConsolidatedProposal.test.ts`
- `test/unit/ProposalExecutor.test.ts`
- `test/integration/KnowledgeCRUD.test.ts`
- `test/integration/BiliDiliPressureTest.test.ts`
- `test/helpers/panorama-mocks.ts`
- `test/unit/RecipeImpactPlanner.test.ts`

判断：

这些测试覆盖迁移期 Drizzle/migration/repository impl 兼容，或是旧 fixture 直接模拟具体 impl。Phase 4 先记录，后续若 Core 提供 testing facade，再逐批替换。

## Boundary gate

`docs/core-import-boundary-allowlist.json` 已更新：

- `referenceCount`: `877`
- `uniqueSpecifierCount`: `204`
- 下调 `ProposalRepository`、`KnowledgeEdgeRepository`、`KnowledgeRepository.impl`、`RecipeSourceRefRepository` 的迁移期引用上限。
- 移除已清零的 `LifecycleEventRepository`、`WarningRepository` 深路径允许项。

阶段 4 后禁止新增 database/repository 深路径调用；新增代码应优先使用 `@alembic/core/database` 和 `@alembic/core/repositories`。

## 验证

已通过：

```bash
npm run lint:core-import-boundary
npm run build:check
```

额外检查：

```bash
./node_modules/.bin/biome check lib/injection/modules/KnowledgeModule.ts lib/injection/modules/InfraModule.ts lib/injection/ServiceMap.ts lib/http/routes/evolution.ts
```

结果：无错误，仅保留 `lib/http/routes/evolution.ts` 中既有未使用 `logger` warning。

## 后续入口

下一阶段按主计划进入 Phase 5：Search / Vector / Guard API 收口。Plugin 侧应优先处理 `unwrapRawDb`、`RawDbSyncAdapter`、SearchEngine/HybridRetriever、GuardCheckEngine 相关深路径，不把 embedding provider、AI reranker、API key 管理迁入 Core。
