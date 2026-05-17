# AlembicPlugin Core Public API Phase 1 Boundary

日期：2026-05-17

来源计划：workspace `docs/alembic-core-public-api-boundary-construction-plan-2026-05-17.md`

## 本阶段范围

Phase 1 在 AlembicPlugin 侧只建立边界门禁和反馈记录，不做大规模 import 替换，不删除外层文件，也不把 Codex tool、MCP schema、channel 发布、plugin cache、runtime packaging 等外层职责迁入 Core。

本阶段没有新增 Core 调用。当前仓库继续保留既有 `@alembic/core/...` 深路径 import，等待 Phase 2 起按模块引入稳定窄入口后再小批次切换。

## 当前扫描基线

扫描范围：`lib`、`bin`、`scripts`、`test`。

扫描方式：`scripts/lint-core-import-boundary.mjs` 只统计静态 `import` / `export from` 和动态 `import()` 的 `@alembic/core` specifier，不把普通字符串、文档文本或插件运行时产物当成新增调用。

当前基线：

| 项目 | 数量 |
| --- | ---: |
| Core import refs | 906 |
| unique Core specifiers | 208 |

当前允许集合固化在 `docs/core-import-boundary-allowlist.json`。这个 allowlist 不是稳定公开 API 清单，只表示 Phase 1 开始前 AlembicPlugin 已存在的 Core 依赖集合。新增 `@alembic/core/...` specifier 必须先通过边界说明，不能因为 Core wildcard export 当前可用就直接接入。

## 新增 Core 引用规则

新增 Core 调用前必须说明：

1. 需要的 Core 能力是什么。
2. 想使用的 import path 是什么。
3. 该能力属于确定性 Core 能力，还是 AlembicPlugin 的 Codex adapter / tool / delivery 逻辑。
4. 是否能通过现有 exact module 完成，还是需要 Core 后续提供稳定 facade。

禁止新增的方向：

- 把 Codex tool schema、MCP envelope、Codex Skill 文案、channel / marketplace 发布逻辑接进 Core。
- 把 `scripts/*codex*`、`release-codex-*`、`sync-codex-*` 的插件交付职责迁入 Core。
- 把 AI provider、API key、模型调用、宿主 AgentRuntime 编排当作 Core 公开能力。

## 特殊 Core 需求记录

### Grammar resources

AlembicPlugin 当前需要 Core grammar resource 的确定性契约，但不需要 Core 接管插件发布路径。

真实调用点：

- `scripts/prepare-codex-plugin-runtime.mjs` 从 `vendor/AlembicCore/resources/grammars` 或 `node_modules/@alembic/core/resources/grammars` 复制 grammar 资源到插件 runtime。
- `scripts/dev-watch-codex-plugin.mjs` 监听 Core grammar 资源变化，触发插件 runtime 刷新。
- `scripts/smoke-codex-plugin.mjs` 与 `scripts/verify-codex-plugin.mjs` 验证 runtime 内存在 `resources/grammars/tree-sitter-typescript.wasm`。

边界结论：

- Core 应拥有 grammar 资源目录、可用性检测、resource resolution 和 AST 降级语义。
- AlembicPlugin 应拥有 Codex 插件 runtime 内的资源复制、tarball 打包、安装路径和 smoke 验证。
- `resources/grammars` 是随包资源契约，不是新的 Core import API。

### Codex runtime packaging

AlembicPlugin 继续拥有 `plugins/alembic-codex/runtime`、`runtime.tgz`、wrapper、`.mcp.json`、channel manifest 和发布校验。

Core 只需要提供可被打包的 deterministic runtime 能力与资源；插件层负责把这些能力装配进 Codex 插件形态。

### Plugin cache

`scripts/sync-codex-plugin-cache.mjs`、`scripts/dev-verify-codex-plugin.mjs`、`scripts/dev-watch-codex-plugin.mjs` 处理的是 Codex 本地插件 cache、local MCP rewrite、installed cache probe 和开发态 refresh。

边界结论：

- plugin cache 是 Codex delivery / adapter 逻辑，留在 AlembicPlugin。
- Core 不感知 Codex cache layout，也不提供 marketplace/channel 发布 API。

## Phase 1 验收方式

AlembicPlugin 侧新增脚本：

```bash
npm run lint:core-import-boundary
```

验收含义：

- 当前 208 个既有 Core specifier 允许继续存在。
- 任何新增未知 `@alembic/core/...` 深路径会失败，并输出文件位置。
- allowlist 必须排序且唯一，避免无意识扩大边界。

后续 Phase 2 开始替换基础设施 API 时，先由 Core 提供稳定入口，再把 allowlist 中对应旧深路径小批次移除。
