# host-runtime — 宿主运行时层(L2)

原 `lib/runtime`(W5-e 改名;`#codex/*` 别名同批退役为 `#host-runtime/*`——双宿主 cc/codex 后旧名名不副实)。分组(W5-c):

| 组 | 职责 |
|---|---|
| `mcp/` | MCP 协议壳+工具 handlers(HostMcpServer 入口;handlers 按工具族一文件一族) |
| `host-adapter/` | 宿主适配(codex/claude-code 判定与差异面) |
| `context/` | 请求级项目定位、运行时身份与嵌入执行契约(ProjectLocationService/ProjectRuntimeContext/ProjectRootResolver/RuntimeContext/EmbeddedRuntimeContract) |
| `jobs/` | Plugin 本地长任务状态与产物存储(PluginJobStore) |
| `status/` | 冷启动/重扫结果仍需的本地 onboarding 投影(OnboardingContract) |

方向公理:L2(本层)→L1(service/recipe-pipeline) 单向;反向由 `scripts/lint-layer-boundary.mjs` 把门。项目身份只来自请求级 `ProjectLocationService`，MCP 工具名与载荷字段保持稳定。
