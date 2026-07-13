import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAlembicDatabase } from '@alembic/core/database';
import { KnowledgeService, type RecipeRetrievalProfile } from '@alembic/core/knowledge';
import { createAlembicRepositories } from '@alembic/core/repositories';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProjectRuntimeContext } from '../../lib/host-runtime/context/ProjectRuntimeContext.js';
import { routeSubmitKnowledgeTool } from '../../lib/host-runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/host-runtime/mcp/handlers/types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('Submit knowledge production integration', () => {
  it('uses the real Core production port, persists a native profile, and stays pending', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-submit-production-'));
    roots.push(projectRoot);
    const workspaceResolver = WorkspaceResolver.fromProject(projectRoot);
    const runtime = await openAlembicDatabase(
      { path: path.join(projectRoot, '.asd', 'alembic.db') },
      { workspaceResolver }
    );
    const repositories = createAlembicRepositories(runtime.connection);
    const knowledgeService = new KnowledgeService(
      repositories.knowledgeRepository,
      { log: async () => undefined },
      null,
      null,
      {
        confidenceRouter: null,
        fileWriter: null,
        qualityScorer: {
          score: () => ({ dimensions: {}, grade: 'A', score: 0.95 }),
        },
        skillHooks: null,
      }
    );
    const services = new Map<string, unknown>([['knowledgeService', knowledgeService]]);
    const container = {
      singletons: {
        _projectRoot: projectRoot,
        _workspaceResolver: workspaceResolver,
      },
      get(name: string) {
        if (!services.has(name)) {
          throw new Error(`service-not-registered:${name}`);
        }
        return services.get(name);
      },
      register(name: string, factory: () => unknown) {
        if (!services.has(name)) {
          services.set(name, factory());
        }
      },
    };
    const source = submitSource();
    const retrievalProfile = nativeProfile(source);
    const ctx: McpContext = {
      container,
      projectRuntime: buildProjectRuntimeContext({ projectRoot }),
    };

    try {
      const result = (await routeSubmitKnowledgeTool(ctx, {
        items: [{ ...source, retrievalProfile }],
        skipConsolidation: true,
      })) as { data: Record<string, unknown>; success: boolean };

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(result.data.production).toEqual({
        capability: 'knowledge-submit',
        source: 'host-agent',
      });
      expect(result.data.readiness).toEqual([
        expect.objectContaining({
          documentSetHash: expect.any(String),
          profileHash: expect.any(String),
          ready: true,
          recipeId: expect.any(String),
          violations: [],
        }),
      ]);
      expect(result.data.retrievalProfiles).toEqual([
        {
          profile: retrievalProfile,
          recipeId: expect.any(String),
        },
      ]);
      expect(result.data.codeEvidence).toEqual([
        {
          coreCodePresent: true,
          provenanceRefs: retrievalProfile.provenance.evidenceRefs,
          readinessViolationCodes: [],
          recipeId: expect.any(String),
        },
      ]);

      const recipeId = (result.data.ids as string[])[0] ?? '';
      const persisted = await repositories.knowledgeRepository.findById(recipeId);
      expect(persisted?.retrievalProfile).toEqual(retrievalProfile);
      expect(persisted?.lifecycle).toBe('pending');
    } finally {
      runtime.close();
    }
  });
});

function submitSource(): Record<string, unknown> {
  return {
    title: 'Route Recipe submissions through the Core production port',
    description: 'Keep host submission and retrieval readiness on one Core production contract.',
    trigger: '@submit-through-production-port',
    language: 'typescript',
    kind: 'pattern',
    category: 'Tool',
    knowledgeType: 'code-pattern',
    doClause: 'Route Recipe submissions through RecipeProductionPort createOrStage',
    dontClause: 'Do not persist Recipe candidates through a host-only creation path',
    whenClause: 'When the Codex MCP host submits a Recipe candidate',
    coreCode: [
      'const result = await gateway.createOrStage(input, context);',
      'const recipeId = result.created[0].id;',
      'const readiness = await gateway.evaluateReadiness(recipeId);',
    ].join('\n'),
    headers: ["import { RecipeProductionGateway } from '@alembic/core/knowledge';"],
    usageGuide:
      '### When to Use\nUse for host Recipe submission.\n\n### When Not to Use\nDo not use for read-only retrieval.\n\n### Key Points\nInspect readiness before publication.',
    reasoning: {
      whyStandard: 'The shared production port preserves one persistence and readiness truth.',
      sources: ['lib/host-runtime/mcp/handlers/tool-router.ts:352-380'],
      confidence: 0.99,
    },
    content: {
      pattern: 'await gateway.createOrStage(input, context);',
      markdown: [
        'Project-specific close-up: the Codex MCP submit route admits a candidate only through the Core Recipe production contract, then exposes the exact readiness report returned for the persisted record.',
        '✅ Route the candidate through Core createOrStage and inspect the persisted recipe before any publication decision.',
        '❌ Do not call a host-only persistence path or infer readiness from prose.',
        '```ts',
        'const staged = await gateway.createOrStage(input, context);',
        'const readiness = await gateway.evaluateReadiness(staged.created[0].id);',
        '```',
        'Source: lib/host-runtime/mcp/handlers/tool-router.ts:352-380',
      ].join('\n'),
      rationale: 'A shared port keeps persistence, projection, and readiness behavior aligned.',
    },
  };
}

function nativeProfile(source: Record<string, unknown>): RecipeRetrievalProfile {
  return {
    schemaVersion: '1',
    primaryLanguage: 'en',
    summary: {
      primary: 'Route Recipe submissions through the Core production port.',
      technicalEnglish: 'Use createOrStage so persistence and readiness stay aligned.',
    },
    concepts: [
      {
        term: 'Recipe production port',
        language: 'en',
        provenanceRefs: ['field:description'],
      },
    ],
    scenarios: [
      {
        text: 'The Codex MCP host submits a Recipe candidate.',
        language: 'en',
        provenanceRefs: ['field:whenClause'],
      },
    ],
    exclusions: [
      {
        text: 'Do not use a host-only persistence path.',
        language: 'en',
        provenanceRefs: ['field:dontClause'],
      },
    ],
    provenance: {
      evidenceRefs: ['lib/host-runtime/mcp/handlers/tool-router.ts:352-380'],
      sourceFieldRefs: [
        'field:title',
        'field:description',
        'field:whenClause',
        'field:doClause',
        'field:dontClause',
        'field:coreCode',
        'field:content.pattern',
        'field:content.markdown',
        'field:content.rationale',
      ],
      sourceContentHash: sourceContentHash(source),
      generator: 'plugin-production-integration-test',
    },
  };
}

function sourceContentHash(source: Record<string, unknown>): string {
  const content = record(source.content);
  const reasoning = record(source.reasoning);
  return stableHash({
    category: text(source.category),
    content: {
      markdown: text(content.markdown),
      pattern: text(content.pattern),
      rationale: text(content.rationale),
    },
    coreCode: text(source.coreCode),
    description: text(source.description),
    dimensionId: text(source.dimensionId),
    doClause: text(source.doClause),
    dontClause: text(source.dontClause),
    kind: text(source.kind),
    knowledgeType: text(source.knowledgeType),
    language: text(source.language),
    moduleName: text(source.moduleName),
    reasoning: {
      sources: stringArray(reasoning.sources),
      whyStandard: text(reasoning.whyStandard),
    },
    tags: stringArray(source.tags),
    title: text(source.title),
    topicHint: text(source.topicHint),
    trigger: text(source.trigger),
    usageGuide: text(source.usageGuide),
    whenClause: text(source.whenClause),
  });
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
