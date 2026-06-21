import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AlembicDatabaseRuntime, openAlembicDatabase } from '@alembic/core/database';
import {
  type AlembicRepositoryBundle,
  createAlembicRepositories,
} from '@alembic/core/repositories';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runHostAgentColdStartWorkflow } from '../../lib/runtime/mcp/host-agent-workflows/cold-start.js';
import { runHostAgentKnowledgeRescanWorkflow } from '../../lib/runtime/mcp/host-agent-workflows/knowledge-rescan.js';
import { routePlanTool } from '../../lib/runtime/mcp/handlers/tool-router.js';
import type { McpContext } from '../../lib/runtime/mcp/handlers/types.js';

interface ToolResponse {
  data?: Record<string, unknown>;
  errorCode?: string;
  message?: string;
  success: boolean;
}

let projectRoot: string;
let runtime: AlembicDatabaseRuntime;
let repositories: AlembicRepositoryBundle;

const silentLogger = {
  info() {},
  warn() {},
};

describe('Plan-driven generation gate', () => {
  beforeEach(async () => {
    projectRoot = createFixtureProject();
    runtime = await openAlembicDatabase(
      { path: path.join(projectRoot, '.asd', 'alembic.db') },
      { workspaceResolver: WorkspaceResolver.fromProject(projectRoot) }
    );
    repositories = createAlembicRepositories(runtime.connection);
  });

  afterEach(() => {
    runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test('blocks bootstrap before cleanup when no confirmed Plan exists', async () => {
    const result = (await runHostAgentColdStartWorkflow(createContext(), {
      rebuild: true,
    })) as ToolResponse;

    expect(result).toMatchObject({
      success: false,
      errorCode: 'PLAN_REQUIRED',
    });
    expect(result.data).toMatchObject({
      needsUserInput: true,
      planGate: expect.objectContaining({ status: 'blocked', generationStage: 'coldStart' }),
    });
    expect(fs.existsSync(path.join(projectRoot, '.asd', '.trash'))).toBe(false);
  });

  test('confirmed Plan drives bootstrap testMode without fullReset', async () => {
    const { dimensionId } = await confirmPlan({
      dimensionStage: 'coldStart',
      modulePath: 'src/api',
    });

    const result = (await runHostAgentColdStartWorkflow(createContext(), {
      dimensions: [dimensionId],
      scaleOverride: { maxFiles: 6, contentMaxLines: 12, totalRecipeBudget: 1 },
      testMode: true,
    })) as ToolResponse;

    expect(result.success).toBe(true);
    expect(result.data?.planGate).toMatchObject({
      cleanupPolicy: 'none',
      generationStage: 'coldStart',
      selectedDimensions: [dimensionId],
      testMode: true,
    });
    expect(result.data?.testMode).toMatchObject({
      enabled: true,
      dimensions: [dimensionId],
    });
    expect(asRecord(result.data?.cleanup)).toMatchObject({
      clearedTables: 0,
      deletedRecipes: 0,
      trash: null,
    });
    expect(fs.existsSync(path.join(projectRoot, '.asd', '.trash'))).toBe(false);
  });

  test('confirmed Plan drives moduleMining rescan with scoped ProjectContext and no cleanup', async () => {
    const { dimensionId } = await confirmPlan({
      dimensionStage: 'deepMining',
      modulePath: 'src/api',
    });

    const result = (await runHostAgentKnowledgeRescanWorkflow(createContext(), {
      dimensions: [dimensionId],
      generationStage: 'moduleMining',
      moduleScope: ['src/api'],
      reason: 'rg4 moduleMining test mode',
      scaleOverride: { maxFiles: 6, contentMaxLines: 12, totalRecipeBudget: 1 },
      testMode: true,
    })) as ToolResponse;

    expect(result.success).toBe(true);
    expect(result.data?.planGate).toMatchObject({
      cleanupPolicy: 'none',
      generationStage: 'moduleMining',
      moduleScope: ['src/api'],
      selectedDimensions: [dimensionId],
      testMode: true,
    });
    expect(result.data?.moduleScope).toEqual(['src/api']);
    expect(asRecord(result.data?.rescan)).toMatchObject({
      cleanedFiles: 0,
      cleanedTables: 0,
      archive: null,
    });
    expect(fs.existsSync(path.join(projectRoot, '.asd', '.trash'))).toBe(false);
  });
});

async function confirmPlan(input: {
  dimensionStage: 'coldStart' | 'deepMining';
  modulePath: string;
}): Promise<{ dimensionId: string; planId: string; version: number }> {
  const draft = (await routePlanTool(createContext(), {
    operation: 'draft',
    allowSignatureMismatch: false,
    allowStaleVersion: false,
    projectRoot,
    hints: {
      maxBudget: 3,
      maxRecommendedDimensions: 3,
    },
  })) as ToolResponse;
  if (!draft.success) {
    throw new Error(`draft failed: ${JSON.stringify(draft, null, 2)}`);
  }
  const plan = asRecord(draft.data?.plan);
  const stored = repositories.planRepository.get(String(plan.planId), Number(plan.version));
  if (!stored) {
    throw new Error('Expected draft Plan to be persisted.');
  }
  const dimensionId = stored.intent.dimensions[0]?.dimensionId;
  if (!dimensionId) {
    throw new Error('Expected draft Plan to contain at least one dimension.');
  }
  const signature = String(draft.data?.projectContextSignature);
  const confirmed = (await routePlanTool(createContext(), {
    operation: 'confirm',
    allowSignatureMismatch: false,
    allowStaleVersion: false,
    basePlanId: String(plan.planId),
    baseVersion: Number(plan.version),
    projectContextSignature: signature,
    selectedDimensions: [
      {
        id: dimensionId,
        reason: `RG4 ${input.dimensionStage} fixture`,
        stage: input.dimensionStage,
        targetRecipes: 1,
      },
    ],
    scale: {
      totalRecipeBudget: 2,
      perStage: { coldStart: 1, deepMining: 1, module: 1 },
    },
    moduleBindings: [
      {
        modulePath: input.modulePath,
        dimensions: [dimensionId],
        targetRecipes: 1,
      },
    ],
    plannedNextActions: [
      {
        tool: 'alembic_rescan',
        reason: 'RG4 Plan-driven generation fixture',
      },
    ],
  })) as ToolResponse;
  expect(confirmed.success).toBe(true);
  return {
    dimensionId,
    planId: String(plan.planId),
    version: Number(plan.version),
  };
}

function createContext(): McpContext {
  const services: Record<string, unknown> = {
    database: runtime.connection,
    knowledgeRepository: repositories.knowledgeRepository,
    lifecycleEventRepository: repositories.lifecycleEventRepository,
    planRepository: repositories.planRepository,
    proposalRepository: repositories.proposalRepository,
    recipeSourceRefRepository: repositories.recipeSourceRefRepository,
  };
  return {
    actor: { role: 'unit-test', user: 'unit-test' },
    container: {
      get: (name: string) => {
        if (!(name in services)) {
          throw new Error(`missing service ${name}`);
        }
        return services[name];
      },
      singletons: {
        _projectRoot: projectRoot,
      },
    },
    logger: silentLogger,
  } as unknown as McpContext;
}

function createFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-tool-fixture-'));
  writeFile(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'plan-tool-fixture',
        main: 'src/App.tsx',
        scripts: { test: 'vitest run' },
        dependencies: { react: '^19.0.0', '@tanstack/react-query': '^5.0.0' },
        devDependencies: { vitest: '^4.0.0', typescript: '^5.0.0' },
      },
      null,
      2
    )
  );
  writeFile(
    root,
    'src/App.tsx',
    [
      'import React from "react";',
      'import { fetchUser } from "./api/client";',
      'export function App() {',
      '  return <main>{fetchUser("42").name}</main>;',
      '}',
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'src/api/client.ts',
    ['export function fetchUser(id: string) {', '  return { id, name: "Ada" };', '}', ''].join('\n')
  );
  writeFile(
    root,
    'src/App.test.ts',
    [
      'import { describe, expect, test } from "vitest";',
      'import { fetchUser } from "./api/client";',
      'describe("fetchUser", () => {',
      '  test("returns a user", () => expect(fetchUser("1").name).toBe("Ada"));',
      '});',
      '',
    ].join('\n')
  );
  return root;
}

function writeFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
