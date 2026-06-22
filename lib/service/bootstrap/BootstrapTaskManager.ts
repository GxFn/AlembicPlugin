// RG9 兼容适配：当前消费者为旧 #service/bootstrap 路径、DI 类型和历史测试。
// 保留原因是维持服务层导入稳定；移除条件是消费者全部切到 #recipe-generation/*；owner: AlembicPlugin RG9。
export * from '#recipe-generation/bootstrap/BootstrapTaskManager.js';
