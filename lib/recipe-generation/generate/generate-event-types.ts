/**
 * W2(2026-07-02 全空间统一):事件 payload 基础契约收编 Core 单源
 * (@alembic/core/knowledge pipelineEventPayloads,与事件名 RECIPE_PIPELINE_EVENTS 同域)。
 * 旧异名 DimensionHostAgentCompletePayload 在 Core 保留为同类型别名。
 */
export type {
  DimensionCheckpointRestoredPayload,
  DimensionCompletePayload,
  DimensionErrorPayload,
  DimensionHostAgentCompletePayload,
  DimensionHostCompletePayload,
  DimensionPipelineCompletePayload,
  DimensionRestoredPayload,
  DimensionSkillPayload,
  DimensionSkippedPayload,
  ProgressPayload,
} from '@alembic/core/knowledge';
