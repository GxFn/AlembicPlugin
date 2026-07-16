import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { GuardCheckEngine } from '@alembic/core/guard';
import Database from 'better-sqlite3';
import ConfigLoader from '../../../infrastructure/config/AppConfigLoader.js';
import { createReadOnlyCodeGuardRepositories } from '../../../repository/guard/ReadOnlyCodeGuardServices.js';
import { CodeGuardInput } from '../../../shared/schemas/mcp-tools.js';
import { codeGuardHandler } from '../handlers/agent-public-tools.js';
import type { McpContext, McpServiceContainer } from '../handlers/types.js';
import type { ToolExecutionContext } from './embedded-executor.js';
import { createKnowledgeUnavailableResult } from './knowledge-unavailable-result.js';
import { resolvePublicKnowledgeReadRoute } from './public-knowledge-read-route.js';
import { createReadOnlySearchSnapshot } from './read-only-search-snapshot.js';

/**
 * Run public Code Guard over one request-scoped DB/WAL/config snapshot.
 *
 * The public host route is observational: violations and Prime alignment are returned to the
 * caller, but the request must never write Guard runs, hit counters, or adoption feedback back to
 * the live knowledge database. Non-public owning runtimes retain their normal writable container.
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
  CodeGuardInput.parse(args);
  const projectRoot = realpathSync.native(
    resolve(requireIdentityPath(identity.projectRoot, 'projectRoot'))
  );
  const readRoute = resolvePublicKnowledgeReadRoute(projectRuntime);
  if (readRoute.state === 'unavailable') {
    return createKnowledgeUnavailableResult('alembic_code_guard', projectRuntime);
  }
  const dataRoot = resolve(readRoute.dataRoot);
  const databasePath = resolve(readRoute.databasePath);

  const snapshot = createReadOnlySearchSnapshot({
    dataRoot,
    databasePath,
    ...(readRoute.strictPublication ? { strictPublication: readRoute.strictPublication } : {}),
  });
  const db = new Database(snapshot.databasePath, { fileMustExist: true, readonly: true });
  try {
    db.pragma('query_only = ON');
    const { knowledgeRepository, sourceRefRepository } = createReadOnlyCodeGuardRepositories(db);
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
              appendRun(): void {},
            };
          default:
            throw new Error(`Request-scoped Code Guard container does not expose ${name}.`);
        }
      },
      singletons: {
        _guardEffectMode: 'observe-only',
        _projectRoot: projectRoot,
        _workspaceResolver: { dataRoot, projectRoot },
      },
    };
    process.stderr.write(
      `[MCP/Guard] request-scoped snapshot route is physically read-only; live effects disabled: projectRoot=${projectRoot} database=${databasePath}\n`
    );
    const ctx: McpContext = { container, projectRuntime };
    return await codeGuardHandler(ctx, args);
  } finally {
    db.close();
    snapshot.dispose();
  }
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

function requireIdentityPath(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`Code Guard project identity is missing ${field}.`);
  }
  return value;
}
