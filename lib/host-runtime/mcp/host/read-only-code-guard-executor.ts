import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { GuardCheckEngine } from '@alembic/core/guard';
import Database from 'better-sqlite3';
import ConfigLoader from '../../../infrastructure/config/AppConfigLoader.js';
import {
  type CodeGuardEffects,
  type GuardViolationRunEffect,
  persistCodeGuardEffects,
} from '../../../repository/guard/CodeGuardEffectRepository.js';
import { createReadOnlyCodeGuardRepositories } from '../../../repository/guard/ReadOnlyCodeGuardServices.js';
import { codeGuardHandler } from '../handlers/agent-public-tools.js';
import type { McpContext, McpServiceContainer } from '../handlers/types.js';
import type { ToolExecutionContext } from './embedded-executor.js';
import { createReadOnlySearchSnapshot } from './read-only-search-snapshot.js';

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
  const projectRoot = realpathSync.native(
    resolve(requireIdentityPath(identity.projectRoot, 'projectRoot'))
  );
  const dataRoot = resolve(requireIdentityPath(identity.dataRoot, 'dataRoot'));
  const databasePath = resolve(requireIdentityPath(identity.databasePath, 'databasePath'));
  const physicalIdentity = resolvePhysicalDatabaseIdentity(databasePath, dataRoot);

  const snapshot = createReadOnlySearchSnapshot(physicalIdentity);
  const db = new Database(snapshot.databasePath, { fileMustExist: true, readonly: true });
  const effects: CodeGuardEffects = {
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
    await flushGuardEffects(databasePath, dataRoot, physicalIdentity.databasePath, effects);
    return result;
  } finally {
    db.close();
    snapshot.dispose();
  }
}

async function flushGuardEffects(
  databasePath: string,
  dataRoot: string,
  expectedPhysicalDatabasePath: string,
  effects: CodeGuardEffects
): Promise<void> {
  if (
    effects.violationRuns.length === 0 &&
    effects.guardHits.size === 0 &&
    effects.primeAdoptions.size === 0
  ) {
    return;
  }
  try {
    const currentIdentity = resolvePhysicalDatabaseIdentity(databasePath, dataRoot);
    if (currentIdentity.databasePath !== expectedPhysicalDatabasePath) {
      throw new Error(
        `Code Guard database identity changed before effect persistence: expected=${expectedPhysicalDatabasePath}, actual=${currentIdentity.databasePath}.`
      );
    }
    persistCodeGuardEffects(currentIdentity.databasePath, effects);
  } catch (err: unknown) {
    process.stderr.write(
      `[MCP/Guard] explicit post-result effect degraded: ${err instanceof Error ? err.message : String(err)}\n`
    );
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
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function resolvePhysicalDatabaseIdentity(
  databasePath: string,
  dataRoot: string
): { dataRoot: string; databasePath: string } {
  const physicalDataRoot = realpathSync.native(dataRoot);
  lstatSync(databasePath);
  const physicalDatabasePath = realpathSync.native(databasePath);
  if (!isWithin(physicalDatabasePath, physicalDataRoot)) {
    throw new Error(
      `Code Guard database physical identity mismatch: database=${physicalDatabasePath}, dataRoot=${physicalDataRoot}.`
    );
  }
  if (!statSync(physicalDatabasePath).isFile()) {
    throw new Error(`Code Guard database is not a regular file: ${physicalDatabasePath}.`);
  }
  return { dataRoot: physicalDataRoot, databasePath: physicalDatabasePath };
}

function requireIdentityPath(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`Code Guard project identity is missing ${field}.`);
  }
  return value;
}
