import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type BootstrapSessionLike,
  validateDimensionCompletionEvidenceGate,
  validateRecipeProductionEvidenceGate,
} from '#recipe-generation/host-agent-workflows/recipe-evidence-gate.js';

describe('HostAgentRecipeEvidenceGate', () => {
  it.each([
    {
      name: 'out-of-root source ref',
      item: { sourceRefs: ['../outside.ts:1'], coreCode: 'export const a = 1;' },
      code: 'SOURCE_REF_INVALID',
    },
    {
      name: 'nonexistent source ref',
      item: { sourceRefs: ['src/missing.ts:1'], coreCode: 'export const a = 1;' },
      code: 'SOURCE_REF_NOT_FOUND',
    },
    {
      name: 'out-of-range source ref',
      item: { sourceRefs: ['src/a.ts:99'], coreCode: 'export const a = 1;' },
      code: 'SOURCE_REF_LINE_OUT_OF_RANGE',
    },
    {
      name: 'snippet mismatch',
      item: { sourceRefs: ['src/a.ts:1'], coreCode: 'export const missing = 3;' },
      code: 'SNIPPET_MISMATCH',
    },
    {
      name: 'placeholder code',
      item: { sourceRefs: ['src/a.ts:1'], coreCode: 'await operation()' },
      code: 'PLACEHOLDER_EVIDENCE',
    },
    {
      name: 'insufficient pattern evidence',
      item: {
        kind: 'pattern',
        sourceRefs: ['src/a.ts:1'],
        coreCode: 'export const a = 1;',
      },
      code: 'INSUFFICIENT_EVIDENCE',
    },
    {
      name: 'stale graph ref',
      item: {
        sourceGraphRefs: ['source-graph:stale:abc'],
        sourceRefs: ['src/a.ts:1'],
        coreCode: 'export const a = 1;',
      },
      code: 'STALE_GRAPH',
    },
  ])('rejects $name before Recipe persistence', ({ code, item }) => {
    const projectRoot = makeProjectRoot();
    const result = validateRecipeProductionEvidenceGate({
      args: { dimensionId: 'architecture' },
      items: [candidate(item)],
      projectRoot,
      session: session(projectRoot),
      skipConsolidation: true,
    });

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(code);
  });

  it('rejects wrong bootstrap project scope', () => {
    const projectRoot = makeProjectRoot();
    const otherRoot = makeProjectRoot();

    const result = validateRecipeProductionEvidenceGate({
      args: { dimensionId: 'architecture' },
      items: [candidate()],
      projectRoot,
      session: session(otherRoot),
      skipConsolidation: false,
    });

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('WRONG_SCOPE');
  });

  it('accepts rich pattern evidence with three concrete source files', () => {
    const projectRoot = makeProjectRoot();

    const result = validateRecipeProductionEvidenceGate({
      args: { dimensionId: 'architecture' },
      items: [
        candidate({
          kind: 'pattern',
          sourceRefs: ['src/a.ts:1', 'src/b.ts:1', 'src/c.ts:1'],
          coreCode: 'export const a = 1;',
        }),
      ],
      projectRoot,
      session: session(projectRoot),
      skipConsolidation: true,
    });

    expect(result.ok).toBe(true);
    expect(result.acceptedEvidence).toMatchObject({
      dimensionId: 'architecture',
      itemCount: 1,
      sessionId: 'session-1',
      skipConsolidationChecked: true,
    });
  });

  it('accepts root-level source refs when the file exists at project root', () => {
    const projectRoot = makeProjectRoot();

    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      '{"name":"root-level-source-ref","type":"module"}\n'
    );
    const result = validateRecipeProductionEvidenceGate({
      args: { dimensionId: 'architecture' },
      items: [
        candidate({
          sourceRefs: ['package.json:1'],
          coreCode: '{"name":"root-level-source-ref","type":"module"}',
          reasoning: {
            confidence: 0.9,
            sources: ['package.json:1'],
          },
        }),
      ],
      projectRoot,
      session: session(projectRoot),
      skipConsolidation: true,
    });

    expect(result.ok).toBe(true);
    expect(result.acceptedEvidence).toMatchObject({
      referencedFiles: ['package.json'],
    });
  });

  it('allows explicitly narrow rule candidates to cite one source file', () => {
    const projectRoot = makeProjectRoot();

    const result = validateRecipeProductionEvidenceGate({
      args: { dimensionId: 'architecture' },
      items: [
        candidate({
          kind: 'pattern',
          scope: 'narrow',
          sourceRefs: ['src/a.ts:1'],
          coreCode: 'export const a = 1;',
        }),
      ],
      projectRoot,
      session: session(projectRoot),
      skipConsolidation: true,
    });

    expect(result.ok).toBe(true);
  });

  it('matches real-agent snippets by significant source lines instead of exact block text', () => {
    const projectRoot = makeProjectRoot();
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'snippet.ts'),
      [
        'export function configureSourceGraph() {',
        '  const mode = "fresh";',
        '  return { mode, ready: true };',
        '}',
        '',
      ].join('\n')
    );

    const result = validateRecipeProductionEvidenceGate({
      args: { dimensionId: 'architecture' },
      items: [
        candidate({
          sourceRefs: ['src/snippet.ts:1-4'],
          coreCode: [
            'export function configureSourceGraph() {',
            '  const mode = "fresh";',
            '  return { mode, ready: true };',
          ].join('\n'),
        }),
      ],
      projectRoot,
      session: session(projectRoot),
      skipConsolidation: true,
    });

    expect(result.ok).toBe(true);
  });

  it('requires graph refs for structured or localized relationship claims', () => {
    const projectRoot = makeProjectRoot();

    const structured = validateRecipeProductionEvidenceGate({
      args: { dimensionId: 'architecture' },
      items: [
        candidate({
          relationshipClaim: true,
        }),
      ],
      projectRoot,
      session: session(projectRoot),
      skipConsolidation: true,
    });
    const localized = validateRecipeProductionEvidenceGate({
      args: { dimensionId: 'architecture' },
      items: [
        candidate({
          content: {
            markdown: '这条知识描述调用链和上游依赖关系，因此必须绑定 fresh source graph refs。',
          },
        }),
      ],
      projectRoot,
      session: session(projectRoot),
      skipConsolidation: true,
    });

    expect(codes(structured)).toContain('GRAPH_REF_INVALID');
    expect(codes(localized)).toContain('GRAPH_REF_INVALID');
  });

  it('blocks dimension completion when qualityReport fails', () => {
    const projectRoot = makeProjectRoot();
    const result = validateDimensionCompletionEvidenceGate({
      analysisText: longAnalysisText(),
      candidateCount: 3,
      dimensionId: 'architecture',
      keyFindings: [
        'Finding one ties the dimension to concrete source references.',
        'Finding two ties the dimension to session-bound Recipe ids.',
        'Finding three ties checkpoint writes to verified evidence.',
      ],
      qualityReport: {
        pass: false,
        totalScore: 42,
        scores: {},
        suggestions: ['repair evidence'],
      },
      referencedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      session: {
        ...session(projectRoot),
        submissionTracker: {
          getSubmissions: () => [
            { recipeId: 'recipe-a', sources: ['src/a.ts:1'] },
            { recipeId: 'recipe-b', sources: ['src/b.ts:1'] },
            { recipeId: 'recipe-c', sources: ['src/c.ts:1'] },
          ],
        },
      },
      submittedRecipeIds: ['recipe-a', 'recipe-b', 'recipe-c'],
    });

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('QUALITY_GATE_FAILED');
  });
});

function makeProjectRoot(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-recipe-gate-'));
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(projectRoot, 'src', 'b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(projectRoot, 'src', 'c.ts'), 'export const c = 3;\n');
  return projectRoot;
}

function session(projectRoot: string): BootstrapSessionLike {
  return {
    id: 'session-1',
    projectRoot,
    dimensions: [{ id: 'architecture' }],
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Source-bound candidate',
    kind: 'fact',
    sourceRefs: ['src/a.ts:1'],
    coreCode: 'export const a = 1;',
    content: {
      markdown:
        'The candidate is bound to a concrete source reference and remains rebuildable from the project files.',
    },
    reasoning: {
      sources: ['src/a.ts:1'],
      confidence: 0.9,
    },
    ...overrides,
  };
}

function codes(result: { violations: Array<{ code: string }> }): string[] {
  return result.violations.map((violation) => violation.code);
}

function longAnalysisText(): string {
  return [
    '## Dimension evidence',
    '',
    '1. The dimension has three session-bound Recipe identifiers.',
    '2. The referenced files overlap the submitted Recipe source references.',
    '3. The checkpoint is allowed only after the quality report passes.',
    '',
    '```ts',
    'export const evidence = "session-bound";',
    '```',
    '',
    'This fixture intentionally stays above the production analysis length floor so the quality failure is the only blocking condition being asserted in this test case.',
    'The additional detail mirrors a real host-agent handoff where source files, Recipe identifiers, and dimension findings must agree before persistence.',
  ].join('\n');
}
