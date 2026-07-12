import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { primeHandler } from '../../lib/host-runtime/mcp/handlers/agent-public-tools.js';
import { recipeMap } from '../../lib/host-runtime/mcp/handlers/recipe-map.js';
import { buildRetrievalCheckpointPosture } from '../../lib/host-runtime/mcp/handlers/retrieval-checkpoint-diagnostics.js';
import { search } from '../../lib/host-runtime/mcp/handlers/search.js';
import type { McpContext } from '../../lib/host-runtime/mcp/handlers/types.js';

const tempRoots: string[] = [];

describe('retrieval checkpoint diagnostics', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('incomplete route literal does not degrade posture when baseline equals HEAD', () => {
    // 真机形态（2026-07-06）：resetBaseline 把基线推进到 folder HEAD，但行上残留
    // unresolved 字面；skipped 轮不落库 → 字面要等下个真实 commit 才翻转。基线已
    // 到位时不应再把检索判为 stale。
    const { projectRoot } = createGitFixture();
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    const repository = {
      get() {
        return {
          checkpointCommit: currentHead,
          folderId: 'root',
          lastRouteStatus: 'unresolved',
          mergeBaseCommit: null,
          projectRoot,
          scopeId: 'single-folder',
          targetCommit: currentHead,
        };
      },
    };
    const posture = buildRetrievalCheckpointPosture(
      { get: (name: string) => (name === 'gitDiffCheckpointRepository' ? repository : null) },
      { projectRoot }
    );
    expect(posture.status).toBe('current');
    expect(posture.retrievalMayBeStale).toBe(false);
    expect(posture.diagnostics).toEqual([]);
  });

  test('a matching scalar checkpoint cannot prove a multi-repo ProjectScope is current', () => {
    const { projectRoot } = createGitFixture();
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    const repository = {
      get() {
        return {
          checkpointCommit: currentHead,
          folderId: 'folder-plugin',
          lastRouteStatus: 'skipped',
          mergeBaseCommit: currentHead,
          projectRoot,
          scopeId: 'project-scope:fixture',
          targetCommit: currentHead,
        };
      },
    };

    const posture = buildRetrievalCheckpointPosture(
      { get: (name: string) => (name === 'gitDiffCheckpointRepository' ? repository : null) },
      {
        currentFolderId: 'folder-plugin',
        projectRoot,
        projectScopeFolderCount: 5,
        projectScopeId: 'fixture',
        scanRoot: projectRoot,
      }
    );

    expect(posture.status).toBe('unknown');
    expect(posture.retrievalMayBeStale).toBe(true);
    expect(posture.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'retrieval-checkpoint-scalar-project-scope'
    );
  });

  test('complete repository revision vectors require every row clean and checkpoint-aligned', () => {
    const first = createGitFixture();
    const second = createGitFixture();
    const heads = new Map([
      ['folder-first', gitOutput(first.projectRoot, ['rev-parse', 'HEAD'])],
      ['folder-second', gitOutput(second.projectRoot, ['rev-parse', 'HEAD'])],
    ]);
    const repository = {
      get(scope: { folderId: string }) {
        const commit = heads.get(scope.folderId);
        return commit
          ? {
              checkpointCommit: commit,
              folderId: scope.folderId,
              lastRouteStatus: 'skipped',
              mergeBaseCommit: commit,
              scopeId: 'project-scope:vector',
              targetCommit: commit,
            }
          : null;
      },
    };
    const input = {
      currentFolderId: 'folder-first',
      projectRoot: first.projectRoot,
      projectScopeFolderCount: 2,
      projectScopeFolders: [
        { folderId: 'folder-first', path: first.projectRoot, repositoryId: 'first' },
        { folderId: 'folder-second', path: second.projectRoot, repositoryId: 'second' },
      ],
      projectScopeId: 'vector',
      scanRoot: first.projectRoot,
    };
    const current = buildRetrievalCheckpointPosture(
      { get: (name: string) => (name === 'gitDiffCheckpointRepository' ? repository : null) },
      input
    );
    expect(current.status).toBe('current');
    expect(current.sourceRevisionManifest).toMatchObject({
      alignment: 'current',
      completeness: 'complete',
      rows: [
        expect.objectContaining({ repositoryId: 'first', status: 'current' }),
        expect.objectContaining({ repositoryId: 'second', status: 'current' }),
      ],
    });

    fs.writeFileSync(path.join(second.projectRoot, 'src/index.ts'), 'export const value = 3;\n');
    const dirty = buildRetrievalCheckpointPosture(
      { get: (name: string) => (name === 'gitDiffCheckpointRepository' ? repository : null) },
      input
    );
    expect(dirty.status).toBe('stale');
    expect(dirty.sourceRevisionManifest?.rows[1]).toMatchObject({
      repositoryId: 'second',
      dirty: true,
      status: 'dirty',
    });
    expect(dirty.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'source-revision-row-misaligned'
    );

    fs.writeFileSync(path.join(second.projectRoot, 'src/index.ts'), 'export const value = 2;\n');
    heads.delete('folder-second');
    const missing = buildRetrievalCheckpointPosture(
      { get: (name: string) => (name === 'gitDiffCheckpointRepository' ? repository : null) },
      input
    );
    expect(missing.status).toBe('stale');
    expect(missing.sourceRevisionManifest?.rows[1]).toMatchObject({
      checkpointCommit: null,
      repositoryId: 'second',
      status: 'missing-checkpoint',
    });
  });

  test('search, prime, and recipe_map expose stale durable checkpoint catch-up posture', async () => {
    const { baselineHead, projectRoot } = createGitFixture();
    const gitDiffCheckpointRepository = createCheckpointRepository(projectRoot, baselineHead);

    const searchOutput = (await search(searchContext(projectRoot, gitDiffCheckpointRepository), {
      projectRoot,
      query: 'checkpoint recipe',
      mode: 'keyword',
    })) as { structuredContent: Record<string, unknown> };
    expect(diagnosticCodes(searchOutput.structuredContent)).toContain('retrieval-catch-up-needed');
    expect(searchOutput.structuredContent.status).toBe('degraded');
    expect(asRecord(searchOutput.structuredContent.result).gitDiffCheckpoint).toMatchObject({
      retrievalMayBeStale: true,
      status: 'stale',
    });
    expect(searchOutput.structuredContent.nextActions).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: 'alembic_rescan', required: true })])
    );

    for (const operation of ['get', 'expand'] as const) {
      const detailOutput = (await search(searchContext(projectRoot, gitDiffCheckpointRepository), {
        operation,
        projectRoot,
        refId: 'recipe-checkpoint',
      })) as { structuredContent: Record<string, unknown> };
      expect(detailOutput.structuredContent.status).toBe('degraded');
      expect(diagnosticCodes(detailOutput.structuredContent)).toContain(
        'retrieval-catch-up-needed'
      );
      expect(asRecord(detailOutput.structuredContent.result).gitDiffCheckpoint).toMatchObject({
        retrievalMayBeStale: true,
        status: 'stale',
      });
    }

    const primeOutput = (await primeHandler(
      primeContext(projectRoot, gitDiffCheckpointRepository, true),
      {
        agentHost: 'codex',
        inputSource: 'host-declared-intent',
        projectRoot,
        requirementGoal: 'Fix stale retrieval checkpoint diagnostics',
        scenario: 'Plugin retrieval consumer visibility',
        taskAction: 'fix',
      }
    )) as Record<string, unknown>;
    expect(primeOutput.status).toBe('degraded');
    expect(asRecord(primeOutput.reason).message).toContain('Git diff checkpoint');
    expect(diagnosticCodes(primeOutput)).toContain('retrieval-catch-up-needed');
    expect(primeOutput.nextActions).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: 'alembic_rescan', required: true })])
    );
    expect(primeOutput.sourceRevisionManifest).toMatchObject({
      completeness: 'complete',
      projectScopeId: 'single-folder',
      rows: [expect.objectContaining({ checkpointCommit: baselineHead, status: 'stale' })],
    });
    const primePackage = asRecord(primeOutput.primePackage);
    const compactPackage = asRecord(primePackage.compactPackage);
    expect(compactPackage.acceptedGuards).toEqual([]);
    expect(compactPackage.acceptedKnowledge).toEqual([]);
    const trustLayers = asArray(asRecord(primePackage.trustPosture).receiptChecklist).map(asRecord);
    expect(trustLayers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: 'trusted-to-obey', itemCount: 0 }),
        expect.objectContaining({ layer: 'trusted-to-use', itemCount: 0 }),
        expect.objectContaining({ layer: 'requires-verification', itemCount: 3 }),
        expect.objectContaining({ layer: 'not-available-or-degraded', itemCount: 2 }),
      ])
    );
    const verificationLayer = trustLayers.find(
      (layer) => layer.layer === 'requires-verification'
    );
    expect(asArray(verificationLayer?.items).map((item) => asRecord(item).id)).toEqual(
      expect.arrayContaining(['recipe-checkpoint', 'rule-checkpoint'])
    );

    const recipeMapOutput = (await recipeMap(
      recipeMapContext(projectRoot, gitDiffCheckpointRepository),
      {
        focus: { kind: 'space' },
        projectRoot,
      }
    )) as { structuredContent: Record<string, unknown> };
    expect(recipeMapOutput.structuredContent.status).toBe('partial');
    expect(diagnosticCodes(recipeMapOutput.structuredContent)).toContain(
      'retrieval-catch-up-needed'
    );
    expect(recipeMapOutput.structuredContent.nextActions).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: 'alembic_rescan', required: true })])
    );
  });
});

function searchContext(projectRoot: string, gitDiffCheckpointRepository: unknown): McpContext {
  return {
    container: {
      get: vi.fn((name: string) => {
        if (name === 'searchEngine') {
          return {
            search: vi.fn(async () => ({
              items: [
                {
                  id: 'recipe-checkpoint',
                  title: 'Checkpoint recipe',
                  trigger: '@checkpoint',
                  kind: 'pattern',
                  language: 'typescript',
                  score: 0.99,
                  description: 'Fixture recipe for checkpoint diagnostics.',
                },
              ],
            })),
          };
        }
        if (name === 'residentServiceClient') {
          return { search: vi.fn(async () => ({ items: [] })) };
        }
        if (name === 'gitDiffCheckpointRepository') {
          return gitDiffCheckpointRepository;
        }
        if (name === 'knowledgeService') {
          const entry = {
            id: 'recipe-checkpoint',
            title: 'Checkpoint recipe',
            trigger: '@checkpoint',
            kind: 'pattern',
            language: 'typescript',
            description: 'Fixture recipe for checkpoint diagnostics.',
            toJSON() {
              return this;
            },
          };
          return {
            get: vi.fn(async () => entry),
            list: vi.fn(async () => ({ data: [entry], pagination: { total: 1 } })),
          };
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
      singletons: { _projectRoot: projectRoot },
    },
  } as unknown as McpContext;
}

function primeContext(
  projectRoot: string,
  gitDiffCheckpointRepository: unknown,
  withTrustedCandidates = false
): McpContext {
  return {
    container: {
      get: vi.fn((name: string) => {
        if (name === 'primeSearchPipeline') {
          return {
            search: vi.fn(async () =>
              withTrustedCandidates
                ? {
                    relatedKnowledge: [
                      {
                        id: 'recipe-checkpoint',
                        title: 'Checkpoint recipe',
                        trigger: '@checkpoint',
                        kind: 'pattern',
                        language: 'typescript',
                        score: 0.99,
                        sourceRefs: ['src/index.ts:1'],
                      },
                    ],
                    guardRules: [
                      {
                        id: 'rule-checkpoint',
                        title: 'Checkpoint rule',
                        trigger: '@checkpoint-rule',
                        kind: 'rule',
                        language: 'typescript',
                        score: 0.98,
                        sourceRefs: ['src/index.ts:1'],
                      },
                    ],
                    searchMeta: {
                      queries: ['checkpoint recipe'],
                      scenario: 'fix',
                      language: 'typescript',
                      module: null,
                      resultCount: 2,
                      filteredCount: 2,
                      primeInjectionPackage: {
                        injection: {
                          degradedReasons: [],
                          omittedCount: 0,
                          selectedCount: 1,
                          status: 'ready',
                        },
                        selectedKnowledge: [
                          {
                            evidenceRefs: ['recipe-locator:recipe-checkpoint'],
                            injectionStatus: 'selected',
                            itemId: 'recipe-checkpoint',
                            matchedRegionClasses: ['applicability'],
                            sourceRefs: ['src/index.ts:1'],
                            whySelected: ['recipe-locator:exact-recipe'],
                          },
                        ],
                        trace: { sourceRefs: ['src/index.ts:1'] },
                      },
                    },
                  }
                : null
            ),
          };
        }
        if (name === 'gitDiffCheckpointRepository') {
          return gitDiffCheckpointRepository;
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
      singletons: { _projectRoot: projectRoot },
    },
  } as unknown as McpContext;
}

function recipeMapContext(projectRoot: string, gitDiffCheckpointRepository: unknown): McpContext {
  return {
    container: {
      get: vi.fn((name: string) => {
        if (name === 'gitDiffCheckpointRepository') {
          return gitDiffCheckpointRepository;
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
      singletons: { _projectRoot: projectRoot },
    },
  } as unknown as McpContext;
}

function createCheckpointRepository(projectRoot: string, checkpointCommit: string) {
  return {
    get(scope: { folderId: string; projectRoot: string; scopeId: string }) {
      if (
        scope.projectRoot !== projectRoot ||
        scope.folderId !== 'root' ||
        scope.scopeId !== 'single-folder'
      ) {
        return null;
      }
      return {
        checkpointCommit,
        folderId: 'root',
        lastRouteStatus: 'skipped',
        mergeBaseCommit: null,
        projectRoot,
        scopeId: 'single-folder',
        targetCommit: checkpointCommit,
      };
    },
  };
}

function createGitFixture(): { baselineHead: string; projectRoot: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-checkpoint-'));
  tempRoots.push(projectRoot);
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"checkpoint-fixture"}\n');
  fs.writeFileSync(path.join(projectRoot, 'src/index.ts'), 'export const value = 1;\n');
  git(projectRoot, ['init']);
  git(projectRoot, ['config', 'user.email', 'test@example.com']);
  git(projectRoot, ['config', 'user.name', 'Alembic Test']);
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-m', 'baseline']);
  const baselineHead = gitOutput(projectRoot, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(projectRoot, 'src/index.ts'), 'export const value = 2;\n');
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-m', 'advance head']);
  return { baselineHead, projectRoot };
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function diagnosticCodes(output: Record<string, unknown>): string[] {
  return asArray(output.diagnostics).map((diagnostic) => String(asRecord(diagnostic).code ?? ''));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
