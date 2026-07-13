import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ProjectContextBuildSessionManager } from '../../lib/service/project-knowledge-context/session/ProjectContextBuildSessionManager.js';
import { defaultProjectGraphProvider } from '../../lib/service/project-knowledge-context/project/ProjectGraphProvider.js';
import { graph } from '../../lib/host-runtime/mcp/handlers/structure.js';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import type { McpContext } from '../../lib/host-runtime/mcp/handlers/types.js';
import { HostMcpServer } from '../../lib/host-runtime/mcp/HostMcpServer.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-build-session-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib/index.ts'), 'export const value = 1;\n');
  return root;
}

describe('ProjectContextBuildSessionManager', () => {
  test('Graph and Recipe Map region consume the same broad fact session', async () => {
    const projectRoot = fixture();
    const manager = new ProjectContextBuildSessionManager({ ttlMs: 5_000 });
    const graph = await defaultProjectGraphProvider.resolveAlembicGraph(
      { projectRoot, queryKind: 'map' },
      { buildSessions: manager }
    );
    const region = await defaultProjectGraphProvider.resolveProjectContextRegion(
      { focus: { kind: 'space' }, projectRoot },
      { buildSessions: manager }
    );
    expect(graph.meta.projectContext?.factSessionRef).toBe(region.meta?.factSessionRef);
    expect(graph.meta.projectContext?.factFingerprint).toBe(region.meta?.factFingerprint);
    expect(manager.debugSnapshot().activeSessions).toBe(1);
    await manager.dispose();
  });

  test('public Graph reconstructs deterministic 2+ cursor pages and supports explicit cancel', async () => {
    const projectRoot = fixture();
    fs.writeFileSync(path.join(projectRoot, 'lib/helper.ts'), 'export const helper = 2;\n');
    const manager = new ProjectContextBuildSessionManager({ ttlMs: 5_000 });
    const ctx: McpContext = {
      container: { get: () => undefined },
      projectRuntime: buildProjectRuntimeContext({ projectRoot }),
      projectContextExecution: { buildSessions: manager },
    };
    const first = (await graph(ctx, { queryKind: 'map', pageSize: 1 })) as {
      structuredContent: {
        continuation: {
          hasMore: boolean;
          nextCursor: string | null;
          resultRef: string;
        };
        nodes: Array<{ id: string }>;
        refs: Array<{ id: string }>;
      };
    };
    expect(first.structuredContent.continuation.hasMore).toBe(true);
    expect(first.structuredContent.continuation.resultRef).not.toContain(projectRoot);
    const nodeIds = first.structuredContent.nodes.map((node) => node.id);
    let cursor = first.structuredContent.continuation.nextCursor;
    let pages = 1;
    while (cursor) {
      const next = (await graph(ctx, { cursor })) as typeof first;
      pages += 1;
      nodeIds.push(...next.structuredContent.nodes.map((node) => node.id));
      cursor = next.structuredContent.continuation.nextCursor;
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(fs.readdirSync(manager.debugSnapshot().tempRoot)).toEqual([]);

    const cancellable = (await graph(ctx, { queryKind: 'map', pageSize: 1 })) as typeof first;
    const cancelCursor = cancellable.structuredContent.continuation.nextCursor!;
    const cancelled = (await graph(ctx, { cancelCursor })) as typeof first;
    expect(cancelled.structuredContent.continuation.hasMore).toBe(false);
    expect(fs.readdirSync(manager.debugSnapshot().tempRoot)).toEqual([]);
    await manager.dispose();
  });

  test('Host reuses a project-confined session across explicit projectRoot calls', async () => {
    const hostRoot = fixture();
    const projectRoot = fixture();
    const projectAlias = path.join(hostRoot, 'project-alias');
    fs.symlinkSync(projectRoot, projectAlias, 'dir');
    const host = new HostMcpServer({ projectRoot: hostRoot });
    try {
      const first = (await host.handleToolCall('alembic_graph', {
        pageSize: 1,
        projectRoot: projectAlias,
        queryKind: 'map',
      })) as {
        structuredContent: { continuation?: { nextCursor: string | null } };
      };
      const cursor = first.structuredContent.continuation?.nextCursor;
      expect(cursor).toBeTruthy();
      const second = (await host.handleToolCall('alembic_graph', {
        cursor,
        projectRoot,
      })) as {
        structuredContent: { continuation?: { page: number } };
      };
      expect(second.structuredContent.continuation?.page).toBe(2);
    } finally {
      await host.shutdown();
    }
  });

  test('merges same-fingerprint in-flight builds and invalidates on source facts without Git', async () => {
    const projectRoot = fixture();
    const manager = new ProjectContextBuildSessionManager({ ttlMs: 5_000 });
    let builds = 0;
    const build = async () => {
      builds += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { build: builds };
    };

    const [first, second] = await Promise.all([
      manager.acquire({ projectRoot, scope: { kind: 'space' }, build }),
      manager.acquire({ projectRoot, scope: { kind: 'space' }, build }),
    ]);
    expect(builds).toBe(1);
    expect(first.factSessionRef).toBe(second.factSessionRef);
    first.release();
    second.release();

    fs.writeFileSync(path.join(projectRoot, 'lib/index.ts'), 'export const value = 2;\n');
    const changed = await manager.acquire({ projectRoot, scope: { kind: 'space' }, build });
    expect(builds).toBe(2);
    expect(changed.factSessionRef).not.toBe(first.factSessionRef);
    changed.release();
    await manager.dispose();
  });

  test('uses ref-counted cancellation and stops the shared worker only after every consumer aborts', async () => {
    const projectRoot = fixture();
    const manager = new ProjectContextBuildSessionManager({ ttlMs: 5_000 });
    const left = new AbortController();
    const right = new AbortController();
    let workerAborted = false;
    const build = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            setTimeout(() => {
              workerAborted = true;
              reject(signal.reason);
            }, 10);
          },
          { once: true }
        );
      });

    const first = manager.acquire({
      projectRoot,
      scope: { kind: 'space' },
      signal: left.signal,
      build,
    });
    const second = manager.acquire({
      projectRoot,
      scope: { kind: 'space' },
      signal: right.signal,
      build,
    });
    left.abort(new DOMException('left cancelled', 'AbortError'));
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(workerAborted).toBe(false);
    right.abort(new DOMException('right cancelled', 'AbortError'));
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(workerAborted).toBe(true);
    await manager.dispose();
  });

  test('creates confined opaque continuation pages and removes temp state at terminal consumption', async () => {
    const projectRoot = fixture();
    const otherRoot = fixture();
    const manager = new ProjectContextBuildSessionManager({ ttlMs: 5_000 });
    const lease = await manager.acquire({
      projectRoot,
      scope: { kind: 'space' },
      build: async () => ({ ids: ['a', 'b', 'c', 'd', 'e'] }),
      chunks: (value) => value.ids.map((id) => ({ id, value: { id } })),
    });
    const first = await manager.publishContinuation({
      projectRoot,
      factSessionRef: lease.factSessionRef,
      items: lease.value.ids,
      pageSize: 2,
    });
    expect(first).toMatchObject({ items: ['a', 'b'], hasMore: true, page: 1 });
    expect(first.resultRef).not.toContain(projectRoot);
    expect(first.nextCursor).not.toContain(projectRoot);
    const tempRoot = manager.debugSnapshot().tempRoot;
    expect(fs.statSync(tempRoot).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(tempRoot).length).toBeGreaterThan(0);
    await expect(
      manager.readContinuation({ projectRoot: otherRoot, cursor: first.nextCursor! })
    ).rejects.toMatchObject({ code: 'PROJECT_CONTEXT_CURSOR_CONFINED' });

    const second = await manager.readContinuation({
      projectRoot,
      cursor: first.nextCursor!,
    });
    expect(second).toMatchObject({ items: ['c', 'd'], hasMore: true, page: 2 });
    const third = await manager.readContinuation({
      projectRoot,
      cursor: second.nextCursor!,
    });
    expect(third).toMatchObject({ items: ['e'], hasMore: false, page: 3 });
    expect([...first.items, ...second.items, ...third.items]).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fs.readdirSync(tempRoot)).toEqual([]);
    lease.release();
    await manager.dispose();
  });

  test('rejects a fact scope that escapes the canonical project root', async () => {
    const projectRoot = fixture();
    const manager = new ProjectContextBuildSessionManager({ ttlMs: 5_000 });
    await expect(
      manager.acquire({
        projectRoot,
        scope: { kind: 'file-symbols', filePath: '../outside.ts' },
        build: async () => ({ unreachable: true }),
      })
    ).rejects.toThrow(/escapes the canonical project root/);
    await manager.dispose();
  });

  test('cleans exception, explicit cancel and TTL state with bounded expired-cursor guidance', async () => {
    const projectRoot = fixture();
    const manager = new ProjectContextBuildSessionManager({ ttlMs: 20 });
    await expect(
      manager.acquire({
        projectRoot,
        scope: { kind: 'space' },
        build: async () => {
          throw new Error('boom');
        },
      })
    ).rejects.toThrow('boom');
    expect(fs.readdirSync(manager.debugSnapshot().tempRoot)).toEqual([]);

    const lease = await manager.acquire({
      projectRoot,
      scope: { kind: 'space' },
      build: async () => ({ ids: ['a', 'b'] }),
    });
    const page = await manager.publishContinuation({
      projectRoot,
      factSessionRef: lease.factSessionRef,
      items: lease.value.ids,
      pageSize: 1,
    });
    await manager.cancelContinuation({ projectRoot, cursor: page.nextCursor! });
    expect(fs.readdirSync(manager.debugSnapshot().tempRoot)).toEqual([]);

    const expiring = await manager.publishContinuation({
      projectRoot,
      factSessionRef: lease.factSessionRef,
      items: lease.value.ids,
      pageSize: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(
      manager.readContinuation({ projectRoot, cursor: expiring.nextCursor! })
    ).rejects.toMatchObject({
      code: 'PROJECT_CONTEXT_CURSOR_EXPIRED',
      retryable: true,
    });
    expect(fs.readdirSync(manager.debugSnapshot().tempRoot)).toEqual([]);
    lease.release();
    await manager.dispose();
  });
});
