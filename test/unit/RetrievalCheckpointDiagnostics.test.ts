import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { primeHandler } from '../../lib/runtime/mcp/handlers/agent-public-tools.js';
import { recipeMap } from '../../lib/runtime/mcp/handlers/recipe-map.js';
import { search } from '../../lib/runtime/mcp/handlers/search.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';

const tempRoots: string[] = [];

describe('retrieval checkpoint diagnostics', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
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

    const primeOutput = (await primeHandler(
      primeContext(projectRoot, gitDiffCheckpointRepository),
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
        throw new Error(`Unexpected service: ${name}`);
      }),
      singletons: { _projectRoot: projectRoot },
    },
  } as unknown as McpContext;
}

function primeContext(projectRoot: string, gitDiffCheckpointRepository: unknown): McpContext {
  return {
    container: {
      get: vi.fn((name: string) => {
        if (name === 'primeSearchPipeline') {
          return { search: vi.fn(async () => null) };
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
