import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ProjectRegistry } from '@alembic/core/workspace';
import { projectLocationService } from '../../lib/host-runtime/context/ProjectLocationService.js';
import { PrimeInput } from '../../lib/shared/schemas/mcp-tools.js';
import { getToolCatalog, HostMcpServer } from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { buildStatusOnboardingContract } from '../../lib/host-runtime/status/OnboardingContract.js';

const tierVariable = ['ALEMBIC', 'MCP', 'TIER'].join('_');
const adminVariable = ['ALEMBIC', 'CODEX', 'ENABLE', 'ADMIN'].join('_');
const originalTier = process.env[tierVariable];
const originalAdmin = process.env[adminVariable];
const originalAlembicHome = process.env.ALEMBIC_HOME;
const temporaryRoots: string[] = [];

describe('independent MCP project location contract', () => {
  afterEach(() => {
    restoreEnv(tierVariable, originalTier);
    restoreEnv(adminVariable, originalAdmin);
    restoreEnv('ALEMBIC_HOME', originalAlembicHome);
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exposes one ordinary tool catalog regardless of obsolete tier variables', () => {
    process.env[tierVariable] = 'agent';
    process.env[adminVariable] = '0';
    const ordinary = getToolCatalog().map((tool) => tool.name);

    process.env[tierVariable] = 'admin';
    process.env[adminVariable] = '1';
    const formerAdmin = getToolCatalog().map((tool) => tool.name);

    expect(new Set(ordinary)).toEqual(new Set(formerAdmin));
    expect(ordinary).toContain('alembic_knowledge_lifecycle');
  });

  test('accepts intent-free Prime input', () => {
    expect(PrimeInput.safeParse({}).success).toBe(true);
    expect(PrimeInput.safeParse({ query: 'request scoped project knowledge' }).success).toBe(true);
  });

  test('does not emit an active-host project alignment gate', () => {
    const contract = buildStatusOnboardingContract({
      dataRoot: '/external/alembic-data',
      projectRoot: '/request/project',
    });
    expect(contract.gates).not.toHaveProperty('scope');
    expect(JSON.stringify(contract)).not.toContain('active Codex host project');
  });

  test('has no live gate, selector, resident identity, or retired-task residue anywhere shipped', () => {
    const source = shippedTextFiles()
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    for (const obsolete of [
      tierVariable,
      adminVariable,
      'HostProjectAlignment',
      'buildLocalSelectionMismatch',
      ['resident', 'ProjectScopeAvailable'].join(''),
      'ServiceRequestBoundary',
      'serviceBoundary',
      ['Alembic', 'ResidentServiceClient'].join(''),
      'ensureResidentDaemonRunning',
      ['ALEMBIC', 'CODEX', 'PROJECT', 'SCOPE', 'SUMMARY'].join('_'),
      'codexProjectScopeExecution',
      'normalizeHostAgentWriteSource',
      'runtime-control.json',
      'selected-project',
      'active-project',
      'active Codex host project',
      'tool-visibility',
      'getVisibleTools',
      'ignoredLegacyPolicyArguments',
    ]) {
      expect(source, `obsolete shipped residue: ${obsolete}`).not.toContain(obsolete);
    }

    const allowedRecipeMaintenance = [
      `${join('lib', 'recipe-pipeline')}/`,
      join('lib', 'host-runtime', 'mcp', 'core-tools', 'output.ts'),
      join('lib', 'host-runtime', 'mcp', 'handlers', 'host-agent', 'evolve.ts'),
      join('lib', 'host-runtime', 'mcp', 'handlers', 'tool-router.ts'),
      join('lib', 'injection', 'ServiceMap.ts'),
      join('lib', 'injection', 'modules', 'InfraModule.ts'),
    ];
    const publicConsumerSource = shippedTextFiles()
      .filter((file) => file.includes(`${join('', 'lib')}/`))
      .filter((file) => {
        const relative = file.slice(process.cwd().length + 1);
        return !allowedRecipeMaintenance.some(
          (allowed) => relative === allowed || relative.startsWith(allowed)
        );
      })
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    for (const obsolete of [
      ['source', 'RevisionManifest'].join(''),
      ['git', 'DiffCheckpoint'].join(''),
      ['retrieval', 'MayBeStale'].join(''),
      'retrievalCheckpoint',
    ]) {
      expect(publicConsumerSource, `public Git consumer residue: ${obsolete}`).not.toContain(
        obsolete
      );
    }
  });

  test('keeps sequential roots isolated and returns truthful no-database results', async () => {
    const first = temporaryProject('first');
    const second = temporaryProject('second');
    const firstServer = new HostMcpServer({ projectRoot: first });
    const secondServer = new HostMcpServer({ projectRoot: second });

    const calls: Array<[string, Record<string, unknown>]> = [
      ['alembic_search', { query: 'missing' }],
      ['alembic_recipe_map', {}],
      ['alembic_prime', { query: 'missing' }],
      ['alembic_code_guard', { code: 'const value = 1;', operation: 'check' }],
    ];
    for (const [name, args] of calls) {
      const firstResult = (await firstServer.handleToolCall(name, args)) as Record<string, unknown>;
      const secondResult = (await secondServer.handleToolCall(name, args)) as Record<
        string,
        unknown
      >;
      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(JSON.stringify(firstResult)).toContain(first);
      expect(JSON.stringify(secondResult)).toContain(second);
      expect(JSON.stringify(firstResult)).not.toContain(second);
      expect(JSON.stringify(secondResult)).not.toContain(first);
    }

    const graph = await firstServer.handleToolCall('alembic_graph', {
      queryKind: 'map',
    });
    expect(JSON.stringify(graph)).toContain(first);
  });

  test('resolves distinct ghost project identities and storage through one service', () => {
    process.env.ALEMBIC_HOME = temporaryProject('home');
    const first = temporaryProject('ghost-first');
    const second = temporaryProject('ghost-second');
    ProjectRegistry.register(first, true);
    ProjectRegistry.register(second, true);

    const firstLocation = projectLocationService.resolve(first);
    const secondLocation = projectLocationService.resolve(second);
    expect(firstLocation.projectId).toBeTruthy();
    expect(secondLocation.projectId).toBeTruthy();
    expect(firstLocation.projectId).not.toBe(secondLocation.projectId);
    expect(firstLocation.dataRoot).not.toBe(secondLocation.dataRoot);
    expect(firstLocation.databasePath).not.toBe(secondLocation.databasePath);
  });

  test('ignores foreign selection files and Git state for request identity and Prime', async () => {
    const home = temporaryProject('foreign-home');
    const projectRoot = temporaryProject('stable-request');
    const foreignRoot = temporaryProject('foreign-project');
    process.env.ALEMBIC_HOME = home;
    const server = new HostMcpServer({ projectRoot });
    const beforeStatus = (await server.handleToolCall('alembic_status', {})) as {
      data: { project: unknown; knowledge: unknown };
    };
    const beforePrime = await server.handleToolCall('alembic_prime', { query: 'missing' });

    const controlRoot = join(home, '.asd');
    mkdirSync(controlRoot, { recursive: true });
    for (const name of ['selected-project.json', 'active-project.json', 'runtime-control.json']) {
      writeFileSync(join(controlRoot, name), JSON.stringify({ projectRoot: foreignRoot }));
    }
    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    writeFileSync(join(projectRoot, '.git', 'HEAD'), 'ref: refs/heads/advanced\n');
    writeFileSync(join(projectRoot, 'dirty.ts'), 'export const dirty = true;\n');

    const afterStatus = (await server.handleToolCall('alembic_status', {})) as {
      data: { project: unknown; knowledge: unknown };
    };
    const afterPrime = await server.handleToolCall('alembic_prime', { query: 'missing' });
    expect(afterStatus.data.project).toEqual(beforeStatus.data.project);
    expect(afterStatus.data.knowledge).toEqual(beforeStatus.data.knowledge);
    expect(afterPrime).toEqual(beforePrime);
  });
});

function temporaryProject(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `alembic-independent-${name}-`));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name }));
  temporaryRoots.push(root);
  return root;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function shippedTextFiles(): string[] {
  const extensions = new Set(['.js', '.json', '.md', '.mjs', '.ts', '.yaml', '.yml']);
  const roots = ['lib', 'bin', 'config', 'docs', 'skills', 'scripts', 'plugins'];
  const files: string[] = [];
  const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules']);
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignoredDirectories.has(entry.name)) continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile() && extensions.has(extname(file))) {
        files.push(file);
      }
    }
  };
  for (const root of roots) {
    visit(join(process.cwd(), root));
  }
  return files;
}
