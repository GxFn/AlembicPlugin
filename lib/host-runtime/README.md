# host-runtime — 宿主运行时层(L2)

原 `lib/runtime`(W5-e 改名;`#codex/*` 别名同批退役为 `#host-runtime/*`——双宿主 cc/codex 后旧名名不副实)。分组(W5-c):

| 组 | 职责 |
|---|---|
| `mcp/` | MCP 协议壳+工具 handlers(HostMcpServer 入口;handlers 按工具族一文件一族) |
| `host-adapter/` | 宿主适配(codex/claude-code 判定与差异面) |
| `context/` | 运行时身份/环境/对齐事实(RuntimeContext/ProjectRuntimeContext/ProjectRootResolver/HostProjectAlignment/PluginRegistry/ModuleBoundary/JobContext/EmbeddedRuntimeContract) |
| `status/` | alembic_status 摘要面(StatusService/OnboardingContract/EnhancementRoute/host-runtime-status) |
| `diagnostics/` | 诊断与预检(Diagnostics/Preflight) |
| `policy/` | 工具可见性/写来源/请求边界策略(ToolPolicy/SourceBoundary/ServiceRequestBoundary) |

方向公理:L2(本层)→L1(service/recipe-pipeline) 单向;反向由 `scripts/lint-layer-boundary.mjs` 把门(白名单仅 host-facts 构建器 2 符号+1 条 type-only 桥,follow-up=DI 注入/类型下沉)。wire 冻结:MCP 工具名/载荷字段/`daemon` 载荷键/磁盘 daemon.json 族(见 AlembicCore/docs/wire-contract.md)。
