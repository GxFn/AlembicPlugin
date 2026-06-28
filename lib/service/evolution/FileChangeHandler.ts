// RG9 兼容适配 / P12 rename shim：当前消费者为旧 #service/evolution 与 FileChangeHandler 名称。
// 保留原因是维持统一演进入口稳定；移除条件是消费者全部切到 HostAgentFileChangeHandler；owner: AlembicPlugin。
export * from '#recipe-generation/evolution/FileChangeHandler.js';
