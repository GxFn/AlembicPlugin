/**
 * IC4/P3 step-7 错误注册表采纳回归：
 * - 插件自有错误码经真实 createCleanMcpError 路径解析出的 failureKind
 *   必须存在于钉死的 Core 注册表（vendor ef83a41）failureKinds 中；
 * - 采纳清单（config/error-registry-adoption.json）与注册表漂移时测试失败；
 * - Recipe evidence gates adopt honest request/consent
 *   taxonomy so they never fall back to core.failure.internal-error.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCleanMcpError } from '#codex/mcp/output-contract.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const registry = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'vendor', 'AlembicCore', 'config', 'error-registry.json'),
    'utf8'
  )
) as { failureKinds: string[] };
const adoption = JSON.parse(
  readFileSync(path.join(repoRoot, 'config', 'error-registry-adoption.json'), 'utf8')
) as {
  pluginOwnedCodeMappings: Record<string, string>;
  recipeEvidenceGateCodeMappings: { codes: string[]; consentCodes: string[] };
};

describe('plugin error codes adopt the Core error registry', () => {
  const expectedKinds: Array<[string, string]> = Object.entries(adoption.pluginOwnedCodeMappings)
    .filter(([, kind]) => !kind.startsWith('deferred'))
    .map(([code, kind]) => [code, kind.split(' ')[0]]);

  it('every adopted mapping resolves to a registry failure kind via the live path', () => {
    for (const [code, expectedKind] of expectedKinds) {
      const error = createCleanMcpError({ code, message: `probe: ${code}` });
      expect(registry.failureKinds, `${code} → ${error.reasonCode}`).toContain(error.reasonCode);
      expect(error.reasonCode, code).toBe(expectedKind);
      expect(error.failureId, code).toBe(`core.failure.${expectedKind}`);
    }
  });

  it('adoption artifact kinds stay within the pinned registry vocabulary', () => {
    for (const [code, kind] of expectedKinds) {
      expect(registry.failureKinds, `${code} declares unknown kind ${kind}`).toContain(kind);
    }
  });

  it('recipe evidence gate codes resolve to caller-repairable taxonomy instead of internal-error', () => {
    expect(adoption.recipeEvidenceGateCodeMappings.codes.length).toBeGreaterThanOrEqual(15);
    for (const code of adoption.recipeEvidenceGateCodeMappings.codes) {
      const error = createCleanMcpError({ code, message: `probe: ${code}` });
      expect(error.reasonCode, `${code} must not be internal`).not.toBe('internal-error');
      expect(error.problemClass, `${code} problemClass`).not.toBe('internal-problem');
      expect(error.retryPolicy, `${code} retryPolicy`).toBeTypeOf('string');
    }
  });

  it('recipe evidence gate consent codes resolve to confirmation-required taxonomy', () => {
    for (const code of adoption.recipeEvidenceGateCodeMappings.consentCodes) {
      const error = createCleanMcpError({ code, message: `probe: ${code}` });
      expect(error.reasonCode, code).toBe('needs-confirmation');
      expect(error.problemClass, code).toBe('confirmation-required');
    }
  });
});
