/** API 文档 - OpenAPI 3.0 规范 */

export const apiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Alembic API',
    description: '自动代码片段管理系统 REST API',
    version: '2.0.0',
    contact: {
      name: 'Alembic Team',
      url: 'https://github.com/GxFn/Alembic',
    },
  },
  servers: [
    {
      url: 'http://localhost:3000/api/v1',
      description: 'Development server',
    },
    {
      url: 'https://api.asd.dev/api/v1',
      description: 'Production server',
    },
  ],
  paths: {
    '/health': {
      get: {
        summary: '健康检查',
        description: '检查服务器是否正常运行',
        tags: ['System'],
        responses: {
          200: {
            description: '服务器状态正常',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    status: { type: 'string', example: 'healthy' },
                    timestamp: { type: 'number', example: 1675900000 },
                    uptime: { type: 'number', example: 3600 },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/health/ready': {
      get: {
        summary: '就绪检查',
        description: '检查服务器是否已准备好处理请求',
        tags: ['System'],
        responses: {
          200: {
            description: '服务器已准备好',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    ready: { type: 'boolean', example: true },
                    timestamp: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

export default apiSpec;
