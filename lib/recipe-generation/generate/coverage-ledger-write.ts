/**
 * coverage-ledger-write — Plugin 侧兼容入口。
 *
 * 覆盖账本写入逻辑已下沉到 @alembic/core/host-agent-workflows；本文件只保留旧
 * #recipe-generation/... import 路径，避免 Codex 插件消费方迁移时再次复制 Core 实现。
 */

export {
  type CoverageLedgerWriteInput,
  type CoverageLedgerWriteLogger,
  type CoverageLedgerWriteResult,
  type DeepMiningRoundReflowResult,
  reflowDeepMiningRoundOnCompletion,
  writeCoverageLedgerForCompletion,
} from '@alembic/core/host-agent-workflows';
