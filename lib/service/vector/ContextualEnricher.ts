// RG9 兼容适配：当前消费者为旧 #service/vector 路径、CLI/DI 和历史测试。
// 保留原因是维持向量配置入口稳定；移除条件是消费者全部切到 #recipe-generation/*；owner: AlembicPlugin RG9。
export * from '#recipe-generation/vector/ContextualEnricher.js';
