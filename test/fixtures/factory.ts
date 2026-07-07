/**
 * Test Fixture Factory — 测试数据工厂
 *
 * 提供：
 *   - createTestBootstrap()  — 轻量化 Bootstrap（内存 DB、静默日志）
 *
 * 历史上还导出过 createTempGitRepo / mockCandidate / mockRecipe / mockGuardRule /
 * mockGatewayRequest / createTestToken / createExpiredToken / getTestPort /
 * onCleanup / runCleanups，均服务于已在 PDR-3（commit 366d81a）删除的 lib/http/**
 * Express 路由 + auth token + HTTP port 测试。这些消费方测试随 lib/http 一起删除后，
 * 上述工厂成为零消费方的死 fixture，已清理；当前唯一消费方是 createTestBootstrap
 * （7 个 integration 测试 named-import）。
 */

/**
 * 创建测试用 Bootstrap 实例（内存 SQLite、静默日志）。
 */
export async function createTestBootstrap() {
  // 动态 import 避免顶层加载问题
  const { Bootstrap } = await import('../../lib/bootstrap.js');
  const bootstrap = new Bootstrap({ env: 'test' });
  const components = await bootstrap.initialize();
  return { bootstrap, components };
}

export default {
  createTestBootstrap,
};
