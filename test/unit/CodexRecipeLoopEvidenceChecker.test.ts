import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type CreateRecipeItem, RecipeProductionGateway } from '@alembic/core/knowledge';
import { WorkspaceResolver } from '@alembic/core/workspace';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const { checkRecipeLoopEvidence } = (await import(
  '../../scripts/lib/codex-recipe-loop-evidence-checker.mjs'
)) as {
  checkRecipeLoopEvidence(options: {
    dimensionId?: string;
    projectRoot: string;
    reportPath?: string;
    transcriptPath?: string;
  }): {
    errors: string[];
    ok: boolean;
    reportPath?: string;
    warnings: string[];
    summary: Record<string, unknown>;
  };
};

let previousAlembicHome: string | undefined;

beforeEach(() => {
  previousAlembicHome = process.env.ALEMBIC_HOME;
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-evidence-home-'));
});

afterEach(() => {
  if (previousAlembicHome === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = previousAlembicHome;
  }
});

describe('Codex recipe loop evidence checker', () => {
  test('accepts an architecture Recipe loop with persisted Recipe, source refs, evidencePlan, and no duplicates', () => {
    const fixture = createEvidenceFixture();
    const reportPath = path.join(fixture.root, 'report.json');

    const report = checkRecipeLoopEvidence({
      projectRoot: fixture.projectRoot,
      reportPath,
      transcriptPath: fixture.transcriptPath,
    });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.summary.recipeFiles).toBe(1);
    expect(report.summary.knowledgeEntries).toBe(1);
    expect(report.summary.rescanEvidencePlanFound).toBe(true);
    expect(report.summary.noDuplicateArchitectureRecipe).toBe(true);
    expect(fs.existsSync(reportPath)).toBe(true);
  });

  test('accepts the real Plugin surface with DB-only staging Recipe, evidenceHints, and PathGuard export warning', () => {
    const fixture = createEvidenceFixture({
      recipeMarkdown: false,
      rescanEvidenceSurface: 'evidenceHints',
      runtimeSkillExportBlocked: true,
    });

    const report = checkRecipeLoopEvidence({
      projectRoot: fixture.projectRoot,
      transcriptPath: fixture.transcriptPath,
    });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toContain(
      'Runtime Skill export was blocked by PathGuard; this is outside the architecture Recipe loop pass/fail scope.'
    );
    expect(report.summary.recipeFiles).toBe(0);
    expect(report.summary.recipePersisted).toBe(true);
    expect(report.summary.rescanEvidenceSurface).toBe('evidenceHints');
    expect(report.summary.runtimeSkillExportBlocked).toBe(true);
  });

  test('rejects duplicate architecture Recipe fingerprints', () => {
    const fixture = createEvidenceFixture({ duplicate: true });

    const report = checkRecipeLoopEvidence({
      projectRoot: fixture.projectRoot,
      transcriptPath: fixture.transcriptPath,
    });

    expect(report.ok).toBe(false);
    expect(report.errors.some((error) => error.includes('Duplicate architecture'))).toBe(true);
  });

  test('acceptance pack submitKnowledgeItem is valid for the V3 Recipe gateway', async () => {
    const pack = JSON.parse(
      fs.readFileSync(
        path.join(
          path.dirname(new URL(import.meta.url).pathname),
          '../codex-acceptance-packs/architecture-recipe-loop/pack.json'
        ),
        'utf8'
      )
    ) as { submitKnowledgeItem: CreateRecipeItem };
    const created: Record<string, unknown>[] = [];
    const gateway = new RecipeProductionGateway({
      knowledgeService: {
        create: async (data: Record<string, unknown>) => {
          created.push(data);
          return {
            ...data,
            id: 'recipe-from-pack',
            lifecycle: 'staging',
            title: String(data.title || ''),
            toJSON() {
              return {
                id: 'recipe-from-pack',
                lifecycle: 'staging',
                title: String(data.title || ''),
              };
            },
          };
        },
        updateQuality: async () => ({ score: 0.9 }),
      },
      projectRoot: '/tmp/alembic-plugin-pack-validation',
    });

    const result = await gateway.create({
      source: 'codex-host-agent',
      items: [pack.submitKnowledgeItem],
      options: { skipConsolidation: true, skipSimilarityCheck: true },
    });

    expect(result.rejected).toEqual([]);
    expect(result.created).toHaveLength(1);
    expect(created[0].trigger).toBe('@architecture-entry-point');
  });
});

function createEvidenceFixture(
  options: {
    duplicate?: boolean;
    recipeMarkdown?: boolean;
    rescanEvidenceSurface?: 'evidenceHints' | 'evidencePlan';
    runtimeSkillExportBlocked?: boolean;
  } = {}
): {
  projectRoot: string;
  root: string;
  transcriptPath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-recipe-loop-evidence-'));
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'index.ts'), 'export const value = 1;\n');

  const resolver = WorkspaceResolver.fromProject(projectRoot);
  fs.mkdirSync(resolver.recipesDir, { recursive: true });
  fs.mkdirSync(path.dirname(resolver.databasePath), { recursive: true });
  if (options.recipeMarkdown !== false) {
    fs.writeFileSync(
      path.join(resolver.recipesDir, 'architecture-entry-point.md'),
      '# Architecture Entry Point\n'
    );
  }

  const db = new Database(resolver.databasePath);
  try {
    db.exec(`
      CREATE TABLE knowledge_entries (
        id TEXT PRIMARY KEY,
        title TEXT,
        trigger TEXT,
        coreCode TEXT,
        lifecycle TEXT,
        dimensionId TEXT,
        sourceFile TEXT,
        reasoning TEXT
      );
      CREATE TABLE recipe_source_refs (
        recipe_id TEXT,
        source_path TEXT,
        status TEXT
      );
    `);
    insertEntry(db, 'recipe-1');
    if (options.duplicate) {
      insertEntry(db, 'recipe-2');
    }
  } finally {
    db.close();
  }

  const transcriptPath = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(
    transcriptPath,
    [
      event('codex.tool_call', 'alembic_bootstrap', { projectRoot }),
      event('tool.result', 'alembic_bootstrap', { success: true }),
      event('codex.tool_call', 'alembic_submit_knowledge', { projectRoot }),
      event('tool.result', 'alembic_submit_knowledge', {
        success: true,
        data: { ids: ['recipe-1'] },
      }),
      event('codex.tool_call', 'alembic_dimension_complete', {
        dimensionId: 'architecture',
        projectRoot,
      }),
      event(
        'tool.result',
        'alembic_dimension_complete',
        options.runtimeSkillExportBlocked
          ? {
              success: true,
              data: {
                runtimeExport: {
                  status: 'failed',
                  message:
                    'Project Skill runtime export failed: [PathGuard] 排除项目保护 (Alembic 生态项目)',
                },
              },
            }
          : { success: true }
      ),
      event('codex.tool_call', 'alembic_rescan', {
        dimensions: ['architecture'],
        projectRoot,
      }),
      event('tool.result', 'alembic_rescan', {
        success: true,
        data:
          options.rescanEvidenceSurface === 'evidenceHints'
            ? {
                evidenceHints: {
                  allRecipes: [
                    {
                      id: 'recipe-1',
                      dimensionId: 'architecture',
                      lifecycle: 'staging',
                      sourceRefs: ['src/index.ts'],
                    },
                  ],
                  rescanMode: true,
                },
                rescan: { preservedRecipes: 1 },
              }
            : { evidencePlan: { preserved: ['recipe-1'] } },
      }),
    ].join('')
  );

  return { projectRoot, root, transcriptPath };
}

function insertEntry(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO knowledge_entries
      (id, title, trigger, coreCode, lifecycle, dimensionId, sourceFile, reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    'Architecture Boundary Uses A Single Entry Point',
    'architecture-entry-point',
    'alembic_bootstrap -> alembic_submit_knowledge -> alembic_dimension_complete',
    'active',
    'architecture',
    'src/index.ts',
    JSON.stringify({ sources: ['src/index.ts'] })
  );
  db.prepare(
    'INSERT INTO recipe_source_refs (recipe_id, source_path, status) VALUES (?, ?, ?)'
  ).run(id, 'src/index.ts', 'active');
}

function event(type: string, tool: string, data: Record<string, unknown>): string {
  const payload = type === 'codex.tool_call' ? { arguments: data } : data;
  return `${JSON.stringify({ data: payload, tool, type })}\n`;
}
