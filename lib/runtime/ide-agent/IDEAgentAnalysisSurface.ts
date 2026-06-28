// P13/R1 兼容 shim：真实宿主 Agent analysis surface 已迁到 runtime/host-agent。
// 旧 IDEAgentAnalysisSurface import 在 G6 清理前继续作为同对象别名，保证旧插件缓存和客户端不破。

export type {
  BuildHostAgentAnalysisSurfaceOptions as BuildIDEAgentAnalysisSurfaceOptions,
  HostAgentAnalysisSurface as IDEAgentAnalysisSurface,
  HostAgentAnalysisUnitSurface as IDEAgentAnalysisUnitSurface,
  HostAgentSurfaceSourceRef as IDEAgentSurfaceSourceRef,
  HostAgentSurfaceStructuralEvidenceRef as IDEAgentSurfaceStructuralEvidenceRef,
} from '#codex/host-agent/HostAgentAnalysisSurface.js';

export * from '#codex/host-agent/HostAgentAnalysisSurface.js';

export {
  buildHostAgentAnalysisProgressBackfill as buildIDEAgentAnalysisProgressBackfill,
  buildHostAgentAnalysisSurface as buildIDEAgentAnalysisSurface,
} from '#codex/host-agent/HostAgentAnalysisSurface.js';
