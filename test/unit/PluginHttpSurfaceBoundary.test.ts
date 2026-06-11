import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODEX_EMBEDDED_RUNTIME_REQUIRED_FILES,
  CODEX_EMBEDDED_RUNTIME_REQUIRED_ROUTES,
  CODEX_EMBEDDED_RUNTIME_RETAINED_DAEMON_ENTRY,
} from '../../lib/codex/runtime/EmbeddedRuntimeContract.js';

const repoRoot = process.cwd();
const source = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
const exists = (path: string) => existsSync(join(repoRoot, path));
const literal = (...parts: string[]) => parts.join('');

describe('Plugin HTTP surface boundary', () => {
  it('removes legacy Dashboard compatibility operation source files', () => {
    expect(
      exists(
        literal('lib/http/compatibility/operations/', 'Dashboard', 'Compatibility', 'Operations.ts')
      )
    ).toBe(false);
    expect(
      exists(
        literal('lib/http/compatibility/operations/dashboard-', 'compatibility-', 'operation.ts')
      )
    ).toBe(false);
  });

  it('does not mount removed AI and Recipe HTTP compatibility routes', () => {
    expect(exists(literal('lib/http/routes/', 'ai.ts'))).toBe(false);
    expect(exists(literal('lib/http/routes/', 'recipes.ts'))).toBe(false);

    const httpServer = source('lib/http/HttpServer.ts');
    expect(httpServer).not.toContain(literal('ai', 'Router'));
    expect(httpServer).not.toContain(literal('recipes', 'Router'));
    expect(httpServer).not.toContain(literal('`${apiPrefix}/', 'ai`'));
    expect(httpServer).not.toContain(literal('`${apiPrefix}/', 'recipes`'));
  });

  it('does not keep removed candidate refine and Dashboard signal page HTTP routes', () => {
    expect(exists(literal('lib/http/routes/', 'candidates.ts'))).toBe(false);
    expect(exists(literal('lib/http/routes/', 'signals.ts'))).toBe(false);

    const httpServer = source('lib/http/HttpServer.ts');
    const requestSchemas = source('lib/shared/schemas/http-requests.ts');
    const embeddedRuntimeContract = source('lib/codex/runtime/EmbeddedRuntimeContract.ts');

    expect(httpServer).not.toContain(literal('candidates', 'Router'));
    expect(httpServer).not.toContain(literal('signals', 'Router'));
    expect(httpServer).not.toContain(literal('`${apiPrefix}/', 'candidates`'));
    expect(httpServer).not.toContain(literal('`${apiPrefix}/', 'signals`'));
    expect(requestSchemas).not.toContain('EnrichBody');
    expect(requestSchemas).not.toContain('BootstrapRefineBody');
    expect(requestSchemas).not.toContain('RefinePreviewBody');
    expect(requestSchemas).not.toContain('RefineApplyBody');
    expect(embeddedRuntimeContract).not.toContain(literal('/api/v1/', 'candidates'));
    expect(embeddedRuntimeContract).not.toContain(literal('/api/v1/', 'signals'));
  });

  it('does not expose old Dashboard caller-only HTTP aliases', () => {
    const jobs = source('lib/http/routes/jobs.ts');

    expect(jobs).toContain('apiBaseUrl');
    expect(jobs).not.toContain('dashboardUrl: buildJobsApiOrigin');
    expect(jobs).not.toContain(literal("'dashboard'"));
  });

  it('does not keep RC4-pruned routes without a plugin-runtime consumer', () => {
    // RC4 route pruning: per-route consumer scans found no MCP handler, daemon,
    // smoke, or acceptance-pack consumer for these HTTP route files.
    for (const route of [
      'audit',
      'commands',
      'extract',
      'guardReport',
      'guardRules',
      'logs',
      'monitoring',
      'violations',
    ]) {
      expect(exists(`lib/http/routes/${route}.ts`)).toBe(false);
    }

    const httpServer = source('lib/http/HttpServer.ts');
    for (const mount of ['monitoring', 'extract', 'commands', 'violations', 'audit', 'logs']) {
      expect(httpServer).not.toContain(`\`\${apiPrefix}/${mount}\``);
    }
    expect(httpServer).not.toContain(literal('`${apiPrefix}/', 'guard/report`'));
    expect(httpServer).not.toContain(literal('`${apiPrefix}/', 'rules`'));
  });

  it('keeps modules free of Dashboard compatibility dispatch', () => {
    const modules = source('lib/http/routes/modules.ts');

    expect(modules).not.toContain(literal('DASHBOARD_', 'COMPATIBILITY_', 'OPERATION_IDS'));
    expect(modules).not.toContain(literal('executeDashboard', 'CompatibilityOperation'));
    expect(modules).not.toContain(literal('sendDashboard', 'CompatibilityOperationResponse'));
    expect(modules).not.toContain(literal('dashboard.', 'update_module_map'));
    expect(modules).not.toContain(literal('dashboard.', 'rebuild_semantic_index'));
    expect(modules).not.toContain(literal('dashboard.', 'scan_project'));
    expect(modules).not.toContain(literal('dashboard.', 'bootstrap_project'));
    expect(modules).not.toContain(literal('dashboard.', 'cancel_bootstrap'));
    expect(modules).not.toContain(literal('dashboard.', 'rescan_project'));
  });

  it('registers SkillHooks through a SkillHooks semantic module', () => {
    const container = source('lib/injection/ServiceContainer.ts');
    const skillHooksModule = source('lib/injection/modules/SkillHooksModule.ts');

    expect(container).toContain(
      "import * as SkillHooksModule from './modules/SkillHooksModule.js'"
    );
    expect(container).toContain('SkillHooksModule.register(this)');
    expect(container).not.toContain(literal('Agent', 'Module'));
    expect(skillHooksModule).toContain("c.singleton('skillHooks'");
    expect(skillHooksModule).toContain('new SkillHooks()');
  });

  it('documents the retained embedded runtime entry files and HTTP contract', () => {
    const moduleBoundary = source('lib/codex/ModuleBoundary.ts');
    const httpServer = source('lib/http/HttpServer.ts');
    const runtimeVerifyScript = source('scripts/verify-codex-runtime-package-boundary.mjs');
    const smokeScript = source('scripts/smoke-codex-plugin.mjs');

    expect(CODEX_EMBEDDED_RUNTIME_RETAINED_DAEMON_ENTRY).toBe('dist/bin/daemon-server.js');
    expect(moduleBoundary).toContain('CODEX_EMBEDDED_RUNTIME_REQUIRED_FILES');
    expect(moduleBoundary).toContain('CODEX_EMBEDDED_RUNTIME_REQUIRED_ROUTES');

    for (const file of CODEX_EMBEDDED_RUNTIME_REQUIRED_FILES) {
      expect(runtimeVerifyScript).toContain(file);
      expect(smokeScript).toContain(file);
    }

    for (const route of CODEX_EMBEDDED_RUNTIME_REQUIRED_ROUTES) {
      const [, mountedPath, childPath = ''] = route.match(/^\/api\/v1\/([^/]+)(?:\/(.+))?$/) ?? [];
      expect(mountedPath).toBeTruthy();
      expect(httpServer).toContain(`\${apiPrefix}/${mountedPath}`);
      if (childPath) {
        expect(
          source(`lib/http/routes/${mountedPath === 'daemon' ? 'daemon' : mountedPath}.ts`)
        ).toContain(`'/${childPath}'`);
      }
    }
  });
});
