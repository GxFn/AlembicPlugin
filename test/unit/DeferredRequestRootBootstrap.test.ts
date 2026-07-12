import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];
let subprocessEntry = '';

describe('deferred request-root MCP bootstrap', () => {
  beforeAll(async () => {
    const buildRoot = temporaryDirectory(join(packageRoot, 'scratch'), 'request-root-bootstrap-');
    subprocessEntry = join(buildRoot, 'host-mcp.mjs');
    await build({
      bundle: true,
      entryPoints: [join(packageRoot, 'bin', 'host-mcp.ts')],
      format: 'esm',
      outfile: subprocessEntry,
      packages: 'external',
      platform: 'node',
      sourcemap: false,
      target: 'node22',
    });
  });

  afterAll(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('starts from a cache-shaped cwd and resolves an explicit request root', async () => {
    const fixture = createFixture('explicit');
    const session = await connectFromCache(fixture);
    try {
      const listed = await session.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain('alembic_status');

      const result = await session.client.callTool({
        name: 'alembic_status',
        arguments: { aspect: 'runtime', projectRoot: fixture.projectRoot },
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.ok).toBe(true);
      expect(structured.project).toMatchObject({
        projectRoot: fixture.projectRoot,
        dataRoot: expect.any(String),
        databasePath: expect.any(String),
      });
      expect(structured.project).toHaveProperty('projectId');
      expect(JSON.stringify(structured.project)).not.toContain(fixture.cacheRoot);
      expect(readdirSync(fixture.cacheRoot)).toEqual([]);
    } finally {
      await session.client.close();
    }
  }, 20_000);

  test('keeps transport alive when an omitted root requires a tool-level error', async () => {
    const fixture = createFixture('omitted');
    const session = await connectFromCache(fixture);
    try {
      const omitted = await session.client.callTool({
        name: 'alembic_status',
        arguments: {},
      });
      expect(omitted.structuredContent).toMatchObject({
        ok: false,
        status: 'project-root-required',
        error: { code: 'PROJECT_ROOT_REQUIRED' },
      });

      const explicit = await session.client.callTool({
        name: 'alembic_status',
        arguments: { projectRoot: fixture.projectRoot },
      });
      expect(explicit.structuredContent).toMatchObject({ ok: true });
    } finally {
      await session.client.close();
    }
  }, 20_000);

  test('uses a trusted host workspace root when the request omits projectRoot', async () => {
    const fixture = createFixture('host-workspace');
    const session = await connectFromCache(fixture, {
      CODEX_WORKSPACE_ROOT: fixture.projectRoot,
    });
    try {
      const result = await session.client.callTool({
        name: 'alembic_status',
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        project: { projectRoot: fixture.projectRoot },
      });
    } finally {
      await session.client.close();
    }
  }, 20_000);
});

function createFixture(name: string) {
  const root = temporaryDirectory(tmpdir(), `alembic-deferred-root-${name}-`);
  const cacheRoot = join(root, '.codex', 'plugins', 'cache', 'gxfn', 'alembic', '0.3.0');
  const projectRoot = join(root, 'request-project');
  const alembicHome = join(root, 'alembic-home');
  mkdirSync(cacheRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(alembicHome, { recursive: true });
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name }));
  return { alembicHome, cacheRoot, projectRoot };
}

async function connectFromCache(
  fixture: ReturnType<typeof createFixture>,
  envOverrides: Record<string, string> = {}
) {
  const stderr: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [subprocessEntry],
    cwd: fixture.cacheRoot,
    env: { ...buildChildEnv(fixture), ...envOverrides },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: 'deferred-request-root-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    return { client, stderr };
  } catch (err: unknown) {
    await client.close().catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}\nchild stderr:\n${stderr.join('')}`);
  }
}

function buildChildEnv(fixture: ReturnType<typeof createFixture>): Record<string, string> {
  const excluded = new Set([
    'CLAUDE_PROJECT_DIR',
    'CODEX_WORKSPACE_DIR',
    'CODEX_WORKSPACE_ROOT',
    'INIT_CWD',
    'PWD',
  ]);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !excluded.has(entry[0])
    )
  );
  return {
    ...inherited,
    ALEMBIC_CODEX_MCP_MODE: '1',
    ALEMBIC_CODEX_PLUGIN_ROOT: fixture.cacheRoot,
    ALEMBIC_HOME: fixture.alembicHome,
    ALEMBIC_MCP_MODE: '1',
    ALEMBIC_PLUGIN_HOST: 'codex',
    ALEMBIC_RUNTIME_MODE: 'plugin',
    INIT_CWD: fixture.cacheRoot,
    PWD: fixture.cacheRoot,
  };
}

function temporaryDirectory(parent: string, prefix: string): string {
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, prefix));
  temporaryRoots.push(root);
  return root;
}
