# AlembicPlugin Core Public API Phase 3 Knowledge

日期：2026-05-17

来源计划：workspace `docs/alembic-core-public-api-boundary-construction-plan-2026-05-17.md`

## 本阶段范围

Phase 3 目标是把 AlembicPlugin 对 Core domain / knowledge 的新增依赖收敛到稳定入口：

- `@alembic/core/dimensions`
- `@alembic/core/knowledge`

Plugin 仍保留 Codex tool、MCP envelope、preflight、policy、channel、runtime packaging 和 tool result 文案。本阶段不把 Codex submit/candidate tool 变成 Core facade。

## 可执行性检查

AlembicPlugin 当前 `vendor/AlembicCore` 指针为 `6358cc7`，`origin/main` 为 `8de77ba`。fetch 后确认两者都尚未暴露以下 package exports：

- `@alembic/core/dimensions`
- `@alembic/core/knowledge`

因此本轮不能把 Plugin import 真实切到 Phase 3 stable facade。AlembicPlugin 不在本仓库补 Core facade，也不引用 sibling `AlembicCore` 工作区里的未提交文件。等 Core 侧提交并更新 `vendor/AlembicCore` 指针后，再执行 import 替换批次。

## 当前依赖基线

扫描范围：`lib`、`bin`、`scripts`、`test`。

当前 Phase 3 相关 transitional Core imports：

| 分组 | specifier 数 | refs |
| --- | ---: | ---: |
| `domain/dimension` | 4 | 15 |
| `domain/knowledge` | 12 | 32 |
| `repository/knowledge` + `repository/sourceref` | 3 | 25 |
| `service/knowledge` | 10 | 46 |
| 合计 | 29 | 118 |

这些引用包括：

- dimension：`DimensionCopy`、`DimensionSop`、`RecipeDimension`、`domain/dimension` 聚合入口。
- knowledge domain：`KnowledgeEntry`、`Lifecycle`、`FieldSpec`、readiness、validator、value objects。
- candidate / submit：`RecipeProductionGateway` 以及 Codex handler 中的创建 item 类型。
- SourceRef：`RecipeSourceRefRepositoryImpl` 相关类型和 repository 实现。
- service：`KnowledgeService`、`KnowledgeSyncService`、`KnowledgeFileWriter`、`SourceRefReconciler`、`CodeEntityGraph`、`ConfidenceRouter` 等。

## 门禁升级

`docs/core-import-boundary-allowlist.json` 新增 `referenceLimits`：

- 对上述 29 个 Phase 3 transitional specifier 锁定当前引用上限。
- 允许未来替换减少引用数量。
- 禁止新增对这些旧深路径的引用，即使 specifier 已在 allowlist 中。

`scripts/lint-core-import-boundary.mjs` 新增检查：

- 继续阻止未知 `@alembic/core/...` specifier。
- 对 `referenceLimits` 中的 transitional specifier，当前 refs 超过上限即失败。
- 输出违反上限的 specifier 和当前 refs，要求使用 stable facade 或先记录 Core facade blocker。

## 暂缓替换批次

等待 Core stable facade 可用后，按以下顺序执行：

1. dimension 批次：
   - `@alembic/core/domain/dimension`
   - `@alembic/core/domain/dimension/DimensionCopy`
   - `@alembic/core/domain/dimension/DimensionSop`
   - `@alembic/core/domain/dimension/RecipeDimension`
2. knowledge domain 批次：
   - `KnowledgeEntry`
   - `Lifecycle`
   - `FieldSpec`
   - readiness / validator / value objects
3. candidate / submit 批次：
   - `RecipeProductionGateway`
   - 保留 Codex tool schema、MCP envelope、tool result 文案在 Plugin。
4. SourceRef 数据契约批次：
   - 只替换 facade 明确导出的数据契约。
   - `RecipeSourceRefRepositoryImpl` 暂不替换，等待 Repository 阶段。
5. KnowledgeService 批次：
   - 只切类型和 stable service facade。
   - 外层 DI wiring、delivery hook、transport wrapper 不删除。

## 明确不做

- 不把 `KnowledgeRepositoryImpl` 迁到 `@alembic/core/knowledge`。
- 不把 Drizzle schema 或 repository impl 当作 Phase 3 stable API。
- 不删除 Plugin 的 Codex adapter、MCP handler、tool schema、policy 或 runtime packaging。
- 不用 wildcard export 当前可用性绕过 stable facade 缺失。

## 验证

本阶段验证命令：

```bash
npm run lint:core-import-boundary
npm run build:check
```

当前 `npm run lint` 仍受既有历史 lint 诊断影响；本阶段新增脚本变更需要单独通过 Biome。
