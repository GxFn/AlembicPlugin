import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildIDEAgentAnalysisPacketFromProjectContext,
  buildProjectContextMissionBriefing,
} from '@alembic/core/host-agent-workflows';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildHostAgentProjectContextAnalysis,
  selectProjectContextDimensions,
} from '../../lib/recipe-generation/host-agent-workflows/project-context-analysis.js';
import { attachPlanScopeTargetCounts } from '../../lib/recipe-generation/host-agent-workflows/cold-start.js';

const tempRoots: string[] = [];

describe('Host Agent ProjectContext direct switch', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it('builds briefing and IDEAgentAnalysis from ProjectContext results directly', async () => {
    const projectRoot = await createTinyTypeScriptProject();
    const analysis = await buildHostAgentProjectContextAnalysis({
      maxFileDetails: 2,
      maxFiles: 20,
      maxModuleDetails: 1,
      maxModuleSeeds: 2,
      projectRoot,
      source: 'codex-host-bootstrap',
    });
    const dimensions = selectProjectContextDimensions(analysis.dimensions).slice(0, 2);

    expect(analysis.requestKinds).toEqual(
      expect.arrayContaining(['space', 'repo', 'map', 'module', 'file-flow', 'file-symbols'])
    );
    expect(analysis.presenterInput.project.projectRoot).toBe(projectRoot);
    expect(analysis.presenterInput.files.map((file) => file.filePath)).toContain('src/index.ts');

    const session = {
      toJSON: () => ({ id: 'session-project-context' }),
    };
    const briefing = buildProjectContextMissionBriefing({
      activeDimensions: dimensions,
      profile: 'cold-start-host-agent',
      projectContext: analysis.presenterInput,
      session,
    });
    const packet = buildIDEAgentAnalysisPacketFromProjectContext({
      dimensions,
      options: { profile: 'cold-start', projectRoot },
      projectContext: analysis.presenterInput,
    });

    expect(briefing.meta?.projectInformationSource).toBe('project-context');
    expect(briefing.projectContext).toMatchObject({ source: 'project-context' });
    expect(packet.meta.source).toBe('project-context');
    expect(packet.retrievalHints.structureTools).toContain('ProjectContext.execute');
    expect(JSON.stringify({ briefing, packet })).not.toMatch(/sourceGraph|panoramaResult/);
  });

  it('feeds real Swift package source counts into bootstrap briefing targets', async () => {
    const projectRoot = await createBiliDiliLikeSwiftProject();
    const analysis = await buildHostAgentProjectContextAnalysis({
      maxFileDetails: 2,
      maxFiles: 4,
      maxModuleDetails: 4,
      maxModuleSeeds: 12,
      projectRoot,
      source: 'codex-host-bootstrap',
    });
    const dimensions = selectProjectContextDimensions(analysis.dimensions).slice(0, 1);

    expect(analysis.fileCount).toBeGreaterThanOrEqual(7);
    expect(analysis.moduleCount).toBeGreaterThanOrEqual(2);
    expect(analysis.sourceFileFacts.map((file) => file.filePath)).toEqual(
      expect.arrayContaining([
        'Packages/AOXFoundationKit/Package.swift',
        'Packages/AOXFoundationKit/Sources/AOXFoundationKit/FoundationClock.swift',
        'Packages/AOXNetworkKit/Sources/AOXNetworkKit/NetworkClient.swift',
      ])
    );
    expect(analysis.moduleSeeds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          moduleName: 'AOXFoundationKit',
          modulePath: 'Packages/AOXFoundationKit',
          ownedFiles: expect.arrayContaining([
            'Packages/AOXFoundationKit/Package.swift',
            'Packages/AOXFoundationKit/Sources/AOXFoundationKit/FoundationClock.swift',
          ]),
        }),
        expect.objectContaining({
          moduleName: 'AOXNetworkKit',
          modulePath: 'Packages/AOXNetworkKit',
          ownedFiles: expect.arrayContaining([
            'Packages/AOXNetworkKit/Package.swift',
            'Packages/AOXNetworkKit/Sources/AOXNetworkKit/NetworkClient.swift',
          ]),
        }),
      ])
    );

    const briefing = buildProjectContextMissionBriefing({
      activeDimensions: dimensions,
      profile: 'cold-start-host-agent',
      projectContext: analysis.presenterInput,
      projectMeta: {
        fileCount: analysis.fileCount,
        moduleCount: analysis.moduleCount,
      },
      session: { toJSON: () => ({ id: 'session-bilidili-like' }) },
    });
    const targets = briefing.targets as Array<{ fileCount?: number; name?: string }>;

    expect(briefing.projectMeta).toMatchObject({
      fileCount: analysis.fileCount,
      moduleCount: analysis.moduleCount,
    });
    expect(targets.find((target) => target.name === 'AOXFoundationKit')).toMatchObject({
      fileCount: 3,
    });
    expect(targets.find((target) => target.name === 'AOXNetworkKit')).toMatchObject({
      fileCount: 4,
    });
  });

  it('honors plan moduleScope for top-level Sources in ProjectContext analysis', async () => {
    const projectRoot = await createBiliDiliLikeSwiftProject();
    const analysis = await buildHostAgentProjectContextAnalysis({
      maxFileDetails: 2,
      maxFiles: 4,
      maxModuleDetails: 4,
      maxModuleSeeds: 12,
      moduleScope: ['Packages/AOXFoundationKit', 'Packages/AOXNetworkKit', 'Sources'],
      projectRoot,
      source: 'codex-host-bootstrap',
    });

    expect(analysis.moduleSeeds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          moduleName: 'Sources',
          modulePath: 'Sources',
          ownedFiles: expect.arrayContaining([
            'Sources/Infrastructure/Networking/Endpoint/Endpoint+Video.swift',
            'Sources/Infrastructure/Networking/Repository/FeedRepository.swift',
          ]),
        }),
      ])
    );

    const briefing = attachPlanScopeTargetCounts(
      buildProjectContextMissionBriefing({
        activeDimensions: selectProjectContextDimensions(analysis.dimensions).slice(0, 1),
        profile: 'cold-start-host-agent',
        projectContext: analysis.presenterInput,
        projectMeta: {
          fileCount: analysis.fileCount,
          moduleCount: analysis.moduleCount,
        },
        session: { toJSON: () => ({ id: 'session-module-scope' }) },
      }),
      {
        moduleScope: ['Packages/AOXFoundationKit', 'Packages/AOXNetworkKit', 'Sources'],
        sourceFileFacts: analysis.sourceFileFacts,
      }
    );
    const targets = briefing.targets as Array<{ fileCount?: number; name?: string }>;

    expect(targets.find((target) => target.name === 'Sources')).toMatchObject({
      fileCount: 3,
    });
  });

  it('keeps Plugin cold-start and rescan workflows off old project-information carriers', async () => {
    const workflowText = await Promise.all([
      readWorkflow('cold-start.ts'),
      readWorkflow('knowledge-rescan.ts'),
    ]);
    const combined = workflowText.join('\n');

    expect(combined).not.toContain('ProjectIntelligenceCapability');
    expect(combined).not.toContain('buildProjectSnapshot');
    expect(combined).not.toContain('ProjectSnapshot');
    expect(combined).not.toContain('buildIDEAgentAnalysisPacketFromSnapshot');
    expect(combined).not.toContain('normalizePanoramaForIDEAgent');
    expect(combined).not.toContain('@alembic/core/workflows/capabilities/project-intelligence');
  });
});

async function createTinyTypeScriptProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'alembic-project-context-direct-'));
  tempRoots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'project-context-direct-test',
        scripts: { test: 'node --test' },
        type: 'module',
      },
      null,
      2
    )
  );
  await writeFile(
    join(root, 'src', 'index.ts'),
    [
      "import { formatName } from './util.js';",
      '',
      'export function run(name: string): string {',
      '  return formatName(name);',
      '}',
      '',
    ].join('\n')
  );
  await writeFile(
    join(root, 'src', 'util.ts'),
    [
      'export function formatName(name: string): string {',
      '  return name.trim().toUpperCase();',
      '}',
      '',
    ].join('\n')
  );
  return root;
}

async function createBiliDiliLikeSwiftProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'alembic-project-context-bilidili-'));
  tempRoots.push(root);
  await writeFixtureFile(
    root,
    'Package.swift',
    [
      '// swift-tools-version: 6.0',
      'import PackageDescription',
      'let package = Package(',
      '  name: "BiliDiliFixture",',
      '  products: [.library(name: "BiliDiliFixture", targets: ["AOXFoundationKit", "AOXNetworkKit"])],',
      '  targets: [',
      '    .target(name: "AOXFoundationKit", path: "Packages/AOXFoundationKit/Sources/AOXFoundationKit"),',
      '    .target(name: "AOXNetworkKit", dependencies: ["AOXFoundationKit"], path: "Packages/AOXNetworkKit/Sources/AOXNetworkKit")',
      '  ]',
      ')',
      '',
    ].join('\n')
  );
  await writeFixtureFile(
    root,
    'Packages/AOXFoundationKit/Package.swift',
    [
      '// swift-tools-version: 6.0',
      'import PackageDescription',
      'let package = Package(',
      '  name: "AOXFoundationKit",',
      '  products: [.library(name: "AOXFoundationKit", targets: ["AOXFoundationKit"])],',
      '  targets: [.target(name: "AOXFoundationKit", path: "Sources/AOXFoundationKit")]',
      ')',
      '',
    ].join('\n')
  );
  await writeFixtureFile(
    root,
    'Packages/AOXFoundationKit/Sources/AOXFoundationKit/FoundationClock.swift',
    [
      'import Foundation',
      'public struct FoundationClock {',
      '  public init() {}',
      '  public func now() -> Date { Date() }',
      '}',
      '',
    ].join('\n')
  );
  await writeFixtureFile(
    root,
    'Packages/AOXFoundationKit/Sources/AOXFoundationKit/FoundationLogger.swift',
    [
      'import Foundation',
      'public enum FoundationLogger {',
      '  public static func info(_ message: String) { print(message) }',
      '}',
      '',
    ].join('\n')
  );
  await writeFixtureFile(
    root,
    'Packages/AOXNetworkKit/Package.swift',
    [
      '// swift-tools-version: 6.0',
      'import PackageDescription',
      'let package = Package(',
      '  name: "AOXNetworkKit",',
      '  products: [.library(name: "AOXNetworkKit", targets: ["AOXNetworkKit"])],',
      '  dependencies: [.package(path: "../AOXFoundationKit")],',
      '  targets: [.target(name: "AOXNetworkKit", dependencies: ["AOXFoundationKit"], path: "Sources/AOXNetworkKit")]',
      ')',
      '',
    ].join('\n')
  );
  await writeFixtureFile(
    root,
    'Packages/AOXNetworkKit/Sources/AOXNetworkKit/NetworkClient.swift',
    [
      'import Foundation',
      'import AOXFoundationKit',
      'public final class NetworkClient {',
      '  public init(clock: FoundationClock = FoundationClock()) {}',
      '  public func fetch() async throws -> Data { Data() }',
      '}',
      '',
    ].join('\n')
  );
  await writeFixtureFile(
    root,
    'Packages/AOXNetworkKit/Sources/AOXNetworkKit/Endpoint.swift',
    [
      'import Foundation',
      'public struct Endpoint {',
      '  public let path: String',
      '}',
      '',
    ].join('\n')
  );
  await writeFixtureFile(
    root,
    'Packages/AOXNetworkKit/Sources/AOXNetworkKit/NetworkError.swift',
    [
      'import Foundation',
      'public enum NetworkError: Error {',
      '  case invalidResponse',
      '}',
      '',
    ].join('\n')
  );
  await writeFixtureFile(
    root,
    'Sources/Infrastructure/Networking/Endpoint/Endpoint+Video.swift',
    [
      'import Foundation',
      'import AOXNetworkKit',
      'public extension Endpoint where Response == VideoInfoData {',
      '  static func videoInfo(bvid: String) -> Endpoint {',
      '    Endpoint(path: "/x/web-interface/view", parameters: ["bvid": bvid])',
      '  }',
      '}',
      '',
    ].join('\n')
  );
  await writeFixtureFile(
    root,
    'Sources/Infrastructure/Networking/Repository/FeedRepository.swift',
    [
      'import AOXFoundationKit',
      'import AOXNetworkKit',
      'public protocol FeedRepositoryProtocol: Sendable {',
      '  func fetchPopular(page: Int, pageSize: Int) async throws -> [VideoModel]',
      '  func fetchRecommend(page: Int, pageSize: Int) async throws -> [VideoModel]',
      '}',
      '',
    ].join('\n')
  );
  await writeFixtureFile(
    root,
    'Sources/Features/Home/HomeViewModel.swift',
    [
      'import Foundation',
      'public final class HomeViewModel {',
      '  public init() {}',
      '}',
      '',
    ].join('\n')
  );
  return root;
}

async function writeFixtureFile(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(root, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

function readWorkflow(fileName: string): Promise<string> {
  return readFile(
    join(process.cwd(), 'lib', 'runtime', 'mcp', 'host-agent-workflows', fileName),
    'utf8'
  );
}
