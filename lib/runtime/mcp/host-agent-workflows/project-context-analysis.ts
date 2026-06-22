// RG9 兼容适配：当前消费者为旧 #codex/mcp/host-agent-workflows 路径和历史测试。
// 保留原因是维持 MCP/相对导入稳定；移除条件是消费者全部切到 #recipe-generation/*；owner: AlembicPlugin RG9。
export * from '#recipe-generation/host-agent-workflows/project-context-analysis.js';
