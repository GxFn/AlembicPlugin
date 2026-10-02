import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import { routeGraphTool } from '../../lib/host-runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/host-runtime/mcp/handlers/types.js';
import { defaultProjectGraphProvider } from '../../lib/service/project-knowledge-context/project/ProjectGraphProvider.js';
import {
  closeProjectIndexRelations,
  openProjectIndexRelations,
  projectIndexDatabasePath,
} from '../../lib/service/project-knowledge-context/project/ProjectIndexRelations.js';

/**
 * 三层调用：queue → cache → store。file-flow 只看得到一个文件自己的出边，
 * "谁调用了 store 里的函数""谁导入了 store"要靠整个项目的源码索引。
 */
const PROJECT_FILES: Record<string, string> = {
  'package.json': '{ "name": "index-relations-fixture", "type": "module" }\n',
  'src/store.ts': [
    'export function readValue(key: string): string {',
    '  return key.trim();',
    '}',
    '',
    'export class Base {}',
    '',
    'export class Store extends Base {',
    '  read(key: string): string {',
    '    return readValue(key);',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/cache.ts': [
    "import { readValue } from './store.js';",
    '',
    'export function load(key: string): string {',
    '  return readValue(key);',
    '}',
    '',
  ].join('\n'),
  'src/queue.ts': [
    "import { load } from './cache.js';",
    '',
    'export function drain(key: string): string {',
    '  return load(key);',
    '}',
    '',
  ].join('\n'),
  'src/derived.ts': [
    "import { Store } from './store.js';",
    '',
    'export class CachedStore extends Store {}',
    '',
  ].join('\n'),
};

interface GraphOutput {
  status: string;
  nodes: Array<{ id: string; nodeType: string; path?: string }>;
  relations: Array<{ fromId: string; relationType: string; toId: string }>;
  refs: Array<{ id: string; kind: string }>;
  diagnostics: Array<{ code: string; message: string }>;
}

const tempRoots: string[] = [];
afterEach(() => {
  closeProjectIndexRelations();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function createProject(files: Record<string, string> = PROJECT_FILES): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-graph-index-')));
  tempRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return root;
}

function createContext(projectRoot: string): McpContext {
  return {
    container: { get: () => undefined, singletons: { _projectRoot: projectRoot } },
    projectRuntime: buildProjectRuntimeContext({ projectRoot }),
  } as unknown as McpContext;
}

async function runGraph(projectRoot: string, args: Record<string, unknown>): Promise<GraphOutput> {
  const result = (await routeGraphTool(createContext(projectRoot), { projectRoot, ...args })) as {
    structuredContent: GraphOutput;
  };
  return result.structuredContent;
}

/** 关系写成"来源 种类 目标"，符号用它所在的文件加名字表示。 */
function describeRelations(output: GraphOutput): string[] {
  const label = (id: string) => {
    const node = output.nodes.find((candidate) => candidate.id === id);
    if (!node) {
      return id;
    }
    return node.nodeType === 'symbol'
      ? `${node.path}#${(node as { label?: string }).label}`
      : (node.path ?? id);
  };
  return output.relations
    .map((relation) => `${label(relation.fromId)} ${relation.relationType} ${label(relation.toId)}`)
    .sort();
}

describe('alembic_graph 带文件锚点的遍历读源码索引', () => {
  test('impact：依赖这个文件的一方，跨文件、反向、隔着几层', async () => {
    const projectRoot = createProject();
    const output = await runGraph(projectRoot, {
      queryKind: 'impact',
      refId: 'file:src/store.ts',
      maxDepth: 3,
      budget: { itemLimit: 60, relationHopLimit: 10 },
    });
    const relations = describeRelations(output);

    // 谁导入了它、谁调用了它的声明——file-flow 给不出这些，它们来自索引。
    expect(relations).toEqual(
      expect.arrayContaining([
        'src/cache.ts imports src/store.ts',
        'src/cache.ts#load calls src/store.ts#readValue',
        // 继承在图的关系种类表里没有，折成文件之间的依赖。
        'src/derived.ts dependsOn src/store.ts',
        'src/cache.ts dependsOn src/store.ts',
        // 隔着一层：queue 依赖 cache，cache 依赖 store。
        'src/queue.ts#drain calls src/cache.ts#load',
        'src/queue.ts dependsOn src/cache.ts',
      ])
    );
    // 影响面只有依赖它的一方：store 自己不依赖别人，图里没有从它指向别的文件的依赖。
    expect(relations.filter((relation) => relation.startsWith('src/store.ts dependsOn'))).toEqual(
      []
    );
    expect(output.nodes.map((node) => node.path)).toEqual(
      expect.arrayContaining(['src/cache.ts', 'src/queue.ts', 'src/derived.ts'])
    );
    // 关系引用带发生位置与内容哈希，宿主可以原样引用，也可以复核。
    expect(output.refs.some((ref) => ref.id.startsWith('relation-site:'))).toBe(true);
    expect(output.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'project-index-unavailable'
    );
  });

  test('neighborhood：两个方向都有，direction 收窄到一边', async () => {
    const projectRoot = createProject();
    const both = describeRelations(
      await runGraph(projectRoot, {
        queryKind: 'neighborhood',
        refId: 'file:src/cache.ts',
        maxDepth: 2,
        budget: { itemLimit: 60, relationHopLimit: 10 },
      })
    );
    expect(both).toEqual(
      expect.arrayContaining([
        'src/queue.ts#drain calls src/cache.ts#load',
        'src/cache.ts#load calls src/store.ts#readValue',
        'src/queue.ts imports src/cache.ts',
        'src/cache.ts imports src/store.ts',
      ])
    );

    const inbound = describeRelations(
      await runGraph(projectRoot, {
        queryKind: 'neighborhood',
        refId: 'file:src/cache.ts',
        direction: 'in',
        maxDepth: 2,
        budget: { itemLimit: 60, relationHopLimit: 10 },
      })
    );
    expect(inbound).toEqual(expect.arrayContaining(['src/queue.ts imports src/cache.ts']));
    expect(inbound).not.toContain('src/cache.ts imports src/store.ts');
  });

  test('Swift：跨文件的调用与协议遵循来自外部引擎，同样进到图里', async () => {
    const projectRoot = createProject({
      'Package.swift':
        '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "App", targets: [.target(name: "App")])\n',
      'Sources/App/Greeter.swift': 'protocol Greeter {\n    func greet() -> [String]\n}\n',
      'Sources/App/Repo.swift': 'final class Repo {\n    func load() -> [String] { [] }\n}\n',
      'Sources/App/Service.swift': [
        'final class Service: Greeter {',
        '    private let repo: Repo',
        '    init(repo: Repo) {',
        '        self.repo = repo',
        '    }',
        '    func greet() -> [String] {',
        '        return repo.load()',
        '    }',
        '}',
        '',
      ].join('\n'),
    });
    const repo = describeRelations(
      await runGraph(projectRoot, {
        queryKind: 'impact',
        refId: 'file:Sources/App/Repo.swift',
        budget: { itemLimit: 60, relationHopLimit: 10 },
      })
    );
    expect(repo).toEqual(
      expect.arrayContaining([
        'Sources/App/Service.swift#greet calls Sources/App/Repo.swift#load',
        'Sources/App/Service.swift dependsOn Sources/App/Repo.swift',
      ])
    );
    // 协议遵循折成文件之间的依赖：改了协议，遵循它的类型所在的文件受影响。
    const greeter = describeRelations(
      await runGraph(projectRoot, {
        queryKind: 'impact',
        refId: 'file:Sources/App/Greeter.swift',
        budget: { itemLimit: 60, relationHopLimit: 10 },
      })
    );
    expect(greeter).toContain('Sources/App/Service.swift dependsOn Sources/App/Greeter.swift');
  }, 60_000);

  test('索引放在宿主数据目录下的独立库文件里，不碰知识库的主库', async () => {
    const projectRoot = createProject();
    const identity = createContext(projectRoot).projectRuntime?.identity as {
      dataRoot: string;
      databasePath: string;
    };
    expect(fs.existsSync(identity.databasePath)).toBe(false);

    await runGraph(projectRoot, { queryKind: 'impact', refId: 'file:src/store.ts' });

    const databasePath = projectIndexDatabasePath(identity.dataRoot);
    expect(path.basename(databasePath)).toBe('source-index.db');
    expect(databasePath).not.toBe(identity.databasePath);
    expect(fs.existsSync(databasePath)).toBe(true);
    // 图工具没有打开、也没有创建主库。
    expect(fs.existsSync(identity.databasePath)).toBe(false);
  });

  test('宿主不给索引时，图里只有这个文件自己的出边', async () => {
    const projectRoot = createProject();
    const output = (await defaultProjectGraphProvider.resolveAlembicGraph({
      projectRoot,
      queryKind: 'impact',
      refId: 'file:src/store.ts',
      maxDepth: 3,
      budget: { itemLimit: 60, relationHopLimit: 10 },
    })) as unknown as GraphOutput;
    const relations = describeRelations(output);
    expect(relations).not.toContain('src/cache.ts imports src/store.ts');
    expect(relations.some((relation) => relation.includes('dependsOn'))).toBe(false);
  });

  test('索引给不出回答时如实说明，图仍给出按文件现算的事实', async () => {
    const projectRoot = createProject();
    const output = (await defaultProjectGraphProvider.resolveAlembicGraph(
      {
        projectRoot,
        queryKind: 'impact',
        refId: 'file:src/store.ts',
        budget: { itemLimit: 60, relationHopLimit: 10 },
      },
      {
        indexRelations: {
          query: async () => {
            throw new Error('fixture: index store is locked');
          },
        },
      }
    )) as unknown as GraphOutput;
    expect(output.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'project-index-unavailable',
          message: expect.stringContaining('fixture: index store is locked'),
        }),
      ])
    );
    expect(output.status).toBe('partial');
    expect(output.nodes.some((node) => node.path === 'src/store.ts')).toBe(true);
  });

  test('不在索引里的文件不算故障', async () => {
    const projectRoot = createProject();
    const relations = openProjectIndexRelations({ projectRoot, dataRoot: projectRoot });
    const envelope = await relations.query({ kind: 'callers', target: { filePath: 'nope.ts' } });
    expect(envelope.errors).toEqual([expect.objectContaining({ code: 'not-found' })]);
    // 同一个入口的正常回答。
    const callers = await relations.query({
      kind: 'callers',
      target: { filePath: 'src/store.ts', symbol: 'readValue' },
    });
    expect(callers.errors).toBeUndefined();
    expect(callers.index).toMatchObject({ available: true, freshness: 'fresh' });
  });
});
