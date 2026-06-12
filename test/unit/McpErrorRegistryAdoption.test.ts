/**
 * IC4/P3 step-7 错误注册表采纳回归：
 * - 插件自有错误码经真实 createCleanMcpError 路径解析出的 failureKind
 *   必须存在于钉死的 Core 注册表（vendor ef83a41）failureKinds 中；
 * - 采纳清单（config/error-registry-adoption.json）与注册表漂移时测试失败；
 * - CKG3 证据门错误码本波不重分类（F2 路由 CKG 复工包），仅作清单存在性校验。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCleanMcpError } from '#codex/mcp/output-contract.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const registry = JSON.parse(
  readFileSync(path.join(repoRoot, 'vendor', 'AlembicCore', 'config', 'error-registry.json'), 'utf8')
) as { failureKinds: string[] };
const adoption = JSON.parse(
  readFileSync(path.join(repoRoot, 'config', 'error-registry-adoption.json'), 'utf8')
) as {
  pluginOwnedCodeMappings: Record<string, string>;
  deferredCkg3GateCodes: { codes: string[] };
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

  it('CKG3 gate codes are listed as deferred, not silently reclassified', () => {
    expect(adoption.deferredCkg3GateCodes.codes.length).toBeGreaterThanOrEqual(15);
    for (const code of adoption.deferredCkg3GateCodes.codes) {
      expect(
        Object.keys(adoption.pluginOwnedCodeMappings).filter(
          (mapped) => mapped === code && !adoption.pluginOwnedCodeMappings[mapped].startsWith('deferred')
        ),
        `${code} must not be mapped this wave`
      ).toHaveLength(0);
    }
  });
});
