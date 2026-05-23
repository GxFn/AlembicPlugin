import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleService } from '../../lib/service/module/ModuleService.js';

const removedLegacyManagedField = ['host', 'Managed'].join('');
const legacyBoundaryField = ['legacy', 'Boundary', 'Code'].join('');

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
      expect(result.hostAgentManaged).toBe(true);
      expect(result.boundaryCode).toBe('HOST_AGENT_MANAGED');
      expect(result.managedBy).toBe('codex-host-agent-or-alembic-resident-service');
      expect(result.localAi).toBe(false);
      expect(result.localAiProvider).toBe(false);
      expect(result.capabilityBoundary.owner).toBe('codex-host-agent');
      expect(result).not.toHaveProperty(removedLegacyManagedField);
      expect(result).not.toHaveProperty(legacyBoundaryField);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
