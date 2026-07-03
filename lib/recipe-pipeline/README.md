# recipe-generation — Recipe 生成维护全链(四环,宿主 Agent 皮)

主体仓 `Alembic/lib/recipe-pipeline` 的宿主侧镜像(W5):同为 Plan/Generate/Curate/Sustain 四环,差异在执行体——本仓由**宿主 Agent(cc/codex)**执行分析与产出,主体由 in-process API Agent 执行。目录与 `#recipe-pipeline/*` 别名已随 W5-d 定名(旧名 recipe-generation 退役)。

| 环 | 目录 | 职责 | 主入口 |
|---|---|---|---|
| Plan(规划) | `plan/` | alembic_plan draft/confirm:项目情报投影→维度与规模决策(宿主 Agent 荐、用户/Agent confirm) | `plan-tool.ts` → `plan-confirm.ts`;门禁 `plan-generation-gate.ts` |
| Generate(生成) | `generate/` | coldStart/rescan 两 stage 的宿主执行面:mission briefing 驱动宿主 Agent 分析→submit;`runtime/` 为任务管理与事件桥(与主体 generate/runtime 同名镜像) | `cold-start.ts` / `knowledge-rescan.ts` → `generate-workflow.ts` |
| Curate(甄选) | `curate/` | 提交门禁宿主接线:委托 Core RecipeAuthoringSpec.validateAgainst(stage2 evidence gate);落库/晋级机制在 Core | `recipe-evidence-gate.ts` |
| Sustain(维护) | `sustain/` | 文件变更驱动进化:git-diff checkpoint、机会式进化、freshness 刷新 | `HostAgentFileChangeHandler.ts` |

- 根件:`contracts.ts`(子系统契约)与 `canonical-module-axis.ts`(plan/tool-router 双环消费)。
- `vector/`:子系统内横切(embedding 相似度注入;RG9 判定留此,勿迁 service/vector)。
- wire 冻结:MCP 工具名/入参 schema/响应载荷字段全程不动(见 AlembicCore/docs/wire-contract.md)。
