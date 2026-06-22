// RG9 兼容适配：当前消费者为旧 #service/evolution 路径和历史测试。
// 保留原因是维持统一演进入口稳定；移除条件是消费者全部切到 #recipe-generation/*；owner: AlembicPlugin RG9。
export * from '#recipe-generation/evolution/FileChangeHandler.js';
