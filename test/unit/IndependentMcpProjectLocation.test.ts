import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ProjectRegistry } from '@alembic/core/workspace';
import { projectLocationService } from '../../lib/host-runtime/context/ProjectLocationService.js';
import { PrimeInput } from '../../lib/shared/schemas/mcp-tools.js';
import {
  getVisibleTools,
  HostMcpServer,
} from '../../lib/host-runtime/mcp/HostMcpServer.js';

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
    const ordinary = getVisibleTools().map((tool) => tool.name);

    process.env[tierVariable] = 'admin';
    process.env[adminVariable] = '1';
    const formerAdmin = getVisibleTools().map((tool) => tool.name);

    expect(new Set(ordinary)).toEqual(new Set(formerAdmin));
    expect(ordinary).toContain('alembic_knowledge_lifecycle');
  });

  test('accepts intent-free Prime input', () => {
    expect(PrimeInput.safeParse({}).success).toBe(true);
    expect(PrimeInput.safeParse({ query: 'request scoped project knowledge' }).success).toBe(true);
  });

  test('has no live gate, selector, resident identity, or retired-task symbols', () => {
    const productionFiles = [
      'lib/host-runtime/mcp/HostMcpServer.ts',
      'lib/host-runtime/mcp/McpServer.ts',
      'lib/host-runtime/mcp/host/tool-visibility.ts',
      'lib/host-runtime/mcp/host/embedded-executor.ts',
      'lib/host-runtime/context/ProjectRuntimeContext.ts',
      'lib/host-runtime/mcp/handlers/agent-public-tools.ts',
      'lib/host-runtime/mcp/handlers/search.ts',
      'lib/host-runtime/mcp/handlers/recipe-map.ts',
      'lib/host-runtime/mcp/handlers/structure.ts',
      'lib/host-runtime/mcp/host/read-only-search-executor.ts',
      'lib/host-runtime/mcp/host/read-only-graph-executor.ts',
      'lib/host-runtime/mcp/host/read-only-recipe-map-executor.ts',
      'lib/host-runtime/mcp/host/read-only-prime-executor.ts',
      'lib/host-runtime/mcp/host/read-only-code-guard-executor.ts',
    ];
    const source = productionFiles
      .map((file) => readFileSync(join(process.cwd(), file), 'utf8'))
      .join('\n');

    for (const obsolete of [
      tierVariable,
      adminVariable,
      'HostProjectAlignment',
      'buildLocalSelectionMismatch',
      ['resident', 'ProjectScopeAvailable'].join(''),
      ['source', 'RevisionManifest'].join(''),
      ['git', 'DiffCheckpoint'].join(''),
      ['retrieval', 'MayBeStale'].join(''),
      'retrievalCheckpoint',
      'ServiceRequestBoundary',
      'serviceBoundary',
      ['Alembic', 'ResidentServiceClient'].join(''),
      'ensureResidentDaemonRunning',
      ['ALEMBIC', 'CODEX', 'PROJECT', 'SCOPE', 'SUMMARY'].join('_'),
      'codexProjectScopeExecution',
      'normalizeHostAgentWriteSource',
    ]) {
      expect(source, `obsolete production symbol: ${obsolete}`).not.toContain(obsolete);
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
      const secondResult = (await secondServer.handleToolCall(name, args)) as Record<string, unknown>;
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
