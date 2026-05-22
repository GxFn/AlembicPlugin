import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
        literal(
          'lib/http/compatibility/operations/dashboard-',
          'compatibility-',
          'operation.ts'
        )
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

  it('keeps commands and modules free of Dashboard compatibility dispatch', () => {
    const commands = source('lib/http/routes/commands.ts');
    const modules = source('lib/http/routes/modules.ts');
    const combined = `${commands}\n${modules}`;

    expect(combined).not.toContain(literal('DASHBOARD_', 'COMPATIBILITY_', 'OPERATION_IDS'));
    expect(combined).not.toContain(literal('executeDashboard', 'CompatibilityOperation'));
    expect(combined).not.toContain(literal('sendDashboard', 'CompatibilityOperationResponse'));
    expect(combined).not.toContain(literal('dashboard.', 'update_module_map'));
    expect(combined).not.toContain(literal('dashboard.', 'rebuild_semantic_index'));
    expect(combined).not.toContain(literal('dashboard.', 'scan_project'));
    expect(combined).not.toContain(literal('dashboard.', 'bootstrap_project'));
    expect(combined).not.toContain(literal('dashboard.', 'cancel_bootstrap'));
    expect(combined).not.toContain(literal('dashboard.', 'rescan_project'));
  });

  it('registers SkillHooks through a SkillHooks semantic module', () => {
    const container = source('lib/injection/ServiceContainer.ts');
    const skillHooksModule = source('lib/injection/modules/SkillHooksModule.ts');

    expect(container).toContain("import * as SkillHooksModule from './modules/SkillHooksModule.js'");
    expect(container).toContain('SkillHooksModule.register(this)');
    expect(container).not.toContain(literal('Agent', 'Module'));
    expect(skillHooksModule).toContain("c.singleton('skillHooks'");
    expect(skillHooksModule).toContain('new SkillHooks()');
  });
});
