# plan — 规划环(宿主侧)

alembic_plan 工具面:`plan-tool.ts`(draft=纯事实采集,无状态)→ `plan-confirm.ts`(confirm=校验 Agent-authored 完整载荷)→ `plan-generation-gate.ts`(plan 驱动生成门禁)。`project-context-anchoring.ts` 提供 ProjectContext 创建指引与锚定。上游契约=Core `@alembic/core/service/planFacts`+`@alembic/core/plans`。
