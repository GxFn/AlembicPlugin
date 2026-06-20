import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { routeGraphTool } from '../../lib/runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';
import {
  ProjectContextRegionSchema,
  type RegionFocusKind,
} from '../../lib/service/project-knowledge-context/contracts/ProjectContextRegion.js';
import { defaultProjectGraphProvider } from '../../lib/service/project-knowledge-context/project/ProjectGraphProvider.js';

const tempRoots: string[] = [];

// The 5 focus kinds GMAP-3 must answer with a bounded region.
const REGION_FOCUS_KINDS: RegionFocusKind[] = ['space', 'repo', 'module', 'file', 'anchor'];
const FILE_SCOPED_FOCUS = new Set<RegionFocusKind>(['file', 'anchor', 'symbol']);

const REGION_NODE_KINDS = new Set([
  'space',
  'repo',
  'map',
  'module-layer',
  'module',
  'directory',
  'file',
  'symbol',
  'source-slice',
  'anchor-range',
]);

interface RegionFocusInput {
  kind: RegionFocusKind;
  refId?: string;
  filePath?: string;
  line?: number;
}

async function region(projectRoot: string, focus: RegionFocusInput) {
  return defaultProjectGraphProvider.resolveProjectContextRegion({ focus, projectRoot });
}

async function graphOutput(projectRoot: string, args: Record<string, unknown>) {
  const result = (await routeGraphTool(createContext(projectRoot), { projectRoot, ...args })) as {
    structuredContent: { nodes: Array<{ id: string }>; refs: Array<{ id: string }> };
  };
  return result.structuredContent;
}

describe('ProjectContextRegion shared region builder (GMAP-3)', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('answers every focus with a bounded, Recipe-free region projection', async () => {
    const projectRoot = createFixtureProject();
    for (const kind of REGION_FOCUS_KINDS) {
      const focus: RegionFocusInput = { kind };
      if (FILE_SCOPED_FOCUS.has(kind)) {
        focus.filePath = 'lib/index.ts';
      }
      const result = await region(projectRoot, focus);

      // Validates the public region contract (strict schema).
      expect(ProjectContextRegionSchema.parse(result)).toEqual(result);

      expect(result.focus.kind).toBe(kind);
      expect(result.rootNode).toBeTruthy();
      expect(result.breadcrumb.length).toBeGreaterThan(0);
      // breadcrumb is the ancestry chain ending at the focus root.
      expect(result.breadcrumb.at(-1)?.nodeId).toBe(result.rootNode.nodeId);

      // Bounded.
      expect(result.nodes.length).toBeLessThanOrEqual(40);
      expect(result.relations.length).toBeLessThanOrEqual(60);
      expect(result.refs.length).toBeLessThanOrEqual(80);

      for (const node of result.nodes) {
        expect(REGION_NODE_KINDS).toContain(node.kind);
      }

      // Recipe-free + no old filesystem-sampling source-of-truth markers.
      const serialized = JSON.stringify(result).toLowerCase();
      expect(serialized).not.toContain('recipe');
      expect(serialized).not.toContain('panorama');
      expect(serialized).not.toContain('sourceoftruth');
    }
  });

  test('derives breadcrumb from ProjectContext parent ownership', async () => {
    const projectRoot = createFixtureProject();
    const result = await region(projectRoot, { kind: 'file', filePath: 'lib/index.ts' });
    expect(result.rootNode.nodeId).toBe('file:lib/index.ts');
    const crumbIds = result.breadcrumb.map((node) => node.nodeId);
    // Top-down ancestry from the project root down to the focus file.
    expect(crumbIds[0]).toBe('project:fixture-project');
    expect(crumbIds.at(-1)).toBe('file:lib/index.ts');
    expect(crumbIds).toContain('directory:lib');
  });

  test('round-trips a ref between alembic_graph and the region (both directions)', async () => {
    const projectRoot = createFixtureProject();

    // Direction A: a graph node id is usable as region focus.refId → same root.
    const graph = await graphOutput(projectRoot, {
      queryKind: 'file-symbols',
      filePath: 'lib/index.ts',
    });
    const graphFileNode = graph.nodes.find((node) => node.id === 'file:lib/index.ts');
    expect(graphFileNode).toBeTruthy();
    const byRef = await region(projectRoot, { kind: 'file', refId: 'file:lib/index.ts' });
    expect(byRef.rootNode.nodeId).toBe('file:lib/index.ts');

    // Direction B: a region node id is usable as alembic_graph.refId.
    const fileRegion = await region(projectRoot, { kind: 'file', filePath: 'lib/index.ts' });
    const regionNodeId = fileRegion.rootNode.nodeId;
    const neighborhood = await graphOutput(projectRoot, {
      queryKind: 'neighborhood',
      refId: regionNodeId,
      relationType: 'imports',
    });
    expect(neighborhood.nodes.some((node) => node.id === regionNodeId)).toBe(true);
  });

  test('graph and region share node + ref semantics for the same focus', async () => {
    const projectRoot = createFixtureProject();
    const graph = await graphOutput(projectRoot, {
      queryKind: 'file-symbols',
      filePath: 'lib/index.ts',
    });
    const fileRegion = await region(projectRoot, { kind: 'file', filePath: 'lib/index.ts' });

    const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
    const regionNodeIds = new Set(fileRegion.nodes.map((node) => node.nodeId));
    // The same file node id appears in both surfaces.
    expect(graphNodeIds.has('file:lib/index.ts')).toBe(true);
    expect(regionNodeIds.has('file:lib/index.ts')).toBe(true);
    // At least one symbol node id is shared between graph and region.
    const sharedSymbol = [...regionNodeIds].some(
      (id) => id.startsWith('symbol:') && graphNodeIds.has(id)
    );
    expect(sharedSymbol).toBe(true);

    // The region's refs are stable ProjectContext ref ids (also surfaced by graph).
    expect(fileRegion.refs.length).toBeGreaterThan(0);
    for (const ref of fileRegion.refs) {
      expect(typeof ref.id).toBe('string');
      expect(ref.id.length).toBeGreaterThan(0);
    }
  });

  test('a file focus without an anchor returns a graph diagnostic, not a fallback tree', async () => {
    const projectRoot = createFixtureProject();
    const result = await region(projectRoot, { kind: 'file' });
    expect(result.nodes).toEqual([]);
    expect(result.rootNode.kind).toBe('space');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'project-context-region-anchor-required'
    );
  });

  test('builds the region directly from ProjectContext, never via the public graph MCP tool', () => {
    const providerSource = fs.readFileSync(
      path.join(
        process.cwd(),
        'lib/service/project-knowledge-context/project/ProjectGraphProvider.ts'
      ),
      'utf8'
    );
    expect(providerSource).toContain('resolveProjectContextRegion');
    expect(providerSource).toContain('ProjectContextCapabilities.execute');
    // No subprocess / public-tool invocation as a project-information source.
    expect(providerSource).not.toContain('child_process');
    expect(providerSource).not.toContain('routeGraphTool');
    expect(providerSource).not.toContain('execSync');
    expect(providerSource).not.toContain('walkProject');
  });
});

function createFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-region-fixture-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      { name: 'fixture-project', main: 'lib/index.ts', scripts: { build: 'tsc -p tsconfig.json' } },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(root, 'lib', 'helper.ts'),
    'export function helper() { return "ok"; }\n'
  );
  fs.writeFileSync(
    path.join(root, 'lib', 'index.ts'),
    'import { helper } from "./helper";\nexport function run() { return helper(); }\n'
  );
  return root;
}

function createContext(projectRoot: string): McpContext {
  return {
    container: {
      get: () => undefined,
      singletons: { _projectRoot: projectRoot },
    },
  } as unknown as McpContext;
}
