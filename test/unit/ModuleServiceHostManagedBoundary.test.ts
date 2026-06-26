import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('derives canonical modules from repo source paths when ProjectContext map is unavailable', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'alembic-plugin-module-axis-'));
    mkdirSync(join(projectRoot, 'Sources', 'App'), { recursive: true });
    mkdirSync(join(projectRoot, 'app'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'Package.swift'),
      'let package = Package(name: "Fixture")\n',
      'utf8'
    );
    writeFileSync(
      join(projectRoot, 'Sources', 'App', 'NetworkModule.swift'),
      'public final class NetworkModule {}\n',
      'utf8'
    );
    writeFileSync(join(projectRoot, 'app', 'AppDelegate.swift'), 'final class AppDelegate {}\n');

    try {
      const service = new ModuleService(projectRoot);
      const modules = await service.listCanonicalModules();
      const paths = modules.map((module) => module.path);

      expect(paths).toEqual(expect.arrayContaining(['Sources', 'app']));
      expect(modules.find((module) => module.path === 'Sources')?.ownedFiles).toContain(
        'Sources/App/NetworkModule.swift'
      );
      expect(modules.find((module) => module.path === 'app')?.ownedFiles).toContain(
        'app/AppDelegate.swift'
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
