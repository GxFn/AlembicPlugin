// P12/R1 兼容 shim：真实宿主 Agent 实现已更名为 HostAgentFileChangeHandler。
// 旧 FileChangeHandler named import 在本波次继续可用，供历史测试、下游插件缓存和 service adapter 平滑迁移。

export type { HostAgentFileChangeHandlerOptions as FileChangeHandlerOptions } from './HostAgentFileChangeHandler.js';
export * from './HostAgentFileChangeHandler.js';
export { HostAgentFileChangeHandler as FileChangeHandler } from './HostAgentFileChangeHandler.js';
