import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { openAlembicDatabase } from '@alembic/core/database';
import { GuardCheckEngine, ViolationsStore } from '@alembic/core/guard';
import { createAlembicRepositories } from '@alembic/core/repositories';
import Database from 'better-sqlite3';
import ConfigLoader from '../../../infrastructure/config/AppConfigLoader.js';
import { createReadOnlyCodeGuardRepositories } from '../../../repository/guard/ReadOnlyCodeGuardServices.js';
import { codeGuardHandler } from '../handlers/agent-public-tools.js';
import type { McpContext, McpServiceContainer } from '../handlers/types.js';
import type { ToolExecutionContext } from './embedded-executor.js';
import { createReadOnlySearchSnapshot } from './read-only-search-snapshot.js';

interface GuardViolationRunEffect {
  filePath?: string;
  summary?: string;
  violations?: Array<Record<string, unknown>>;
}

interface GuardEffects {
  guardHits: Map<string, number>;
  primeAdoptions: Map<string, number>;
  violationRuns: GuardViolationRunEffect[];
}

/**
 * Run public Code Guard over one request-scoped DB/WAL/config snapshot.
 *
 * Guard is read-mostly, but a real violation and Prime feedback are declared persistent effects.
 * The request therefore audits only the private snapshot, collects those effects, and opens the
 * live database only after a business result exists and only when an effect must be committed.
 */
export async function executeReadOnlyCodeGuard(
  args: Record<string, unknown>,
  executionContext: ToolExecutionContext
): Promise<unknown> {
  const projectRuntime = executionContext.projectRuntime;
  if (!projectRuntime) {
    throw new Error('Request-scoped ProjectRuntimeContext is required for Code Guard.');
  }
  const identity = projectRuntime.identity;
  const projectRoot = resolve(requireIdentityPath(identity.projectRoot, 'projectRoot'));
  const dataRoot = resolve(requireIdentityPath(identity.dataRoot, 'dataRoot'));
  const databasePath = resolve(requireIdentityPath(identity.databasePath, 'databasePath'));
  if (!isWithin(databasePath, dataRoot)) {
    throw new Error(
      `Code Guard database identity mismatch: database=${databasePath}, dataRoot=${dataRoot}.`
    );
  }
  if (!existsSync(databasePath)) {
    throw new Error(`Code Guard database does not exist: ${databasePath}.`);
  }

  const snapshot = createReadOnlySearchSnapshot({ dataRoot, databasePath });
  const db = new Database(snapshot.databasePath, { fileMustExist: true, readonly: true });
  const effects: GuardEffects = {
    guardHits: new Map(),
    primeAdoptions: new Map(),
    violationRuns: [],
  };
  try {
    db.pragma('query_only = ON');
    const { knowledgeRepository, sourceRefRepository } = createReadOnlyCodeGuardRepositories(db, {
      recordGuardHits: (id, count) => incrementEffect(effects.guardHits, id, count),
      recordPrimeAdoptions: (id, count) => incrementEffect(effects.primeAdoptions, id, count),
    });
    const guardCheckEngine = new GuardCheckEngine(
      db as unknown as ConstructorParameters<typeof GuardCheckEngine>[0],
      {
        guardConfig: readGuardConfig(snapshot.configPath),
        knowledgeRepo: knowledgeRepository as never,
      }
    );
    const container: McpServiceContainer = {
      get(name: string): unknown {
        switch (name) {
          case 'database':
            return db;
          case 'guardCheckEngine':
            return guardCheckEngine;
          case 'knowledgeRepository':
            return knowledgeRepository;
          case 'recipeSourceRefRepository':
            return sourceRefRepository;
          case 'violationsStore':
            return {
              appendRun(run: GuardViolationRunEffect): void {
                effects.violationRuns.push(run);
              },
            };
          default:
            throw new Error(`Request-scoped Code Guard container does not expose ${name}.`);
        }
      },
      singletons: {
        _projectRoot: projectRoot,
        _workspaceResolver: { dataRoot, projectRoot },
      },
    };
    process.stderr.write(
      `[MCP/Guard] request-scoped snapshot route is physically read-only: projectRoot=${projectRoot} database=${databasePath}\n`
    );
    const ctx: McpContext = { container, projectRuntime };
    const result = await codeGuardHandler(ctx, args);
    await flushGuardEffects(databasePath, dataRoot, effects);
    return result;
  } finally {
    db.close();
    snapshot.dispose();
  }
}

async function flushGuardEffects(
  databasePath: string,
  dataRoot: string,
  effects: GuardEffects
): Promise<void> {
  if (
    effects.violationRuns.length === 0 &&
    effects.guardHits.size === 0 &&
    effects.primeAdoptions.size === 0
  ) {
    return;
  }
  let runtime: Awaited<ReturnType<typeof openAlembicDatabase>> | null = null;
  try {
    runtime = await openAlembicDatabase(
      { path: databasePath },
      { runMigrations: false, workspaceResolver: { dataRoot } as never }
    );
    const repositories = createAlembicRepositories(runtime.connection);
    const violationsStore = new ViolationsStore(runtime.sqlite, runtime.drizzle);
    for (const run of effects.violationRuns) {
      violationsStore.appendRun(run);
    }
    for (const [id, count] of effects.guardHits) {
      repositories.knowledgeRepository.incrementGuardHitsSync(id, count);
    }
    for (const [id, count] of effects.primeAdoptions) {
      repositories.knowledgeRepository.incrementPrimeAdoptionsSync(id, count);
    }
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/Guard] explicit post-result effect degraded: ${err instanceof Error ? err.message : String(err)}\n`
    );
  } finally {
    runtime?.close();
  }
}

function incrementEffect(effects: Map<string, number>, id: string, count: number): void {
  effects.set(id, (effects.get(id) ?? 0) + count);
}

function readGuardConfig(configPath: string): Record<string, unknown> {
  ConfigLoader.load(process.env.NODE_ENV || 'development');
  const base = asRecord(ConfigLoader.get('guard'));
  let project: Record<string, unknown> = {};
  try {
    project = asRecord(asRecord(JSON.parse(readFileSync(configPath, 'utf8'))).guard);
  } catch {
    // A malformed optional project override must not suppress the packaged Guard defaults.
  }
  const merged = { ...base, ...project };
  const baseThresholds = asRecord(base.codeLevelThresholds);
  const projectThresholds = asRecord(project.codeLevelThresholds);
  if (Object.keys(baseThresholds).length > 0 || Object.keys(projectThresholds).length > 0) {
    merged.codeLevelThresholds = { ...baseThresholds, ...projectThresholds };
  }
  const disabledRules = [
    ...(Array.isArray(base.disabledRules) ? base.disabledRules : []),
    ...(Array.isArray(project.disabledRules) ? project.disabledRules : []),
  ].filter((value): value is string => typeof value === 'string');
  if (disabledRules.length > 0) {
    merged.disabledRules = [...new Set(disabledRules)];
  }
  return merged;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isWithin(filePath: string, root: string): boolean {
  const rel = relative(root, filePath);
  return rel.length > 0 && !rel.startsWith('..') && !rel.startsWith('/');
}

function requireIdentityPath(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`Code Guard project identity is missing ${field}.`);
  }
  return value;
}
