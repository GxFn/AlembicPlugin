import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleService } from '../../lib/service/module/ModuleService.js';

describe('ModuleService host-managed scan boundary', () => {
  it('returns source files with canonical host-agent-managed boundary fields', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'alembic-plugin-module-'));
    writeFileSync(join(projectRoot, 'index.ts'), 'export const answer = 42;\n', 'utf8');

    try {
      const service = new ModuleService(projectRoot);
      const result = (await service.scanTarget({
        name: 'manual-folder',
        path: projectRoot,
        discovererId: 'folder-scan',
      })) as Record<string, unknown>;

      expect(result.scannedFiles).toHaveLength(1);
      expect(result.noAi).toBe(true);
      expect(result.hostManaged).toBe(true);
      expect(result.boundaryCode).toBe('HOST_AGENT_MANAGED');
      expect(result.legacyBoundaryCode).toBe('HOST_AI_MANAGED');
      expect(result.localAi).toBe(false);
      expect(result.localAiProvider).toBe(false);
      expect(result.capabilityBoundary.owner).toBe('codex-host-agent');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
