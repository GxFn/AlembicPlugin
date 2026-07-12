import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAlembicResidentServiceStatus,
  createProjectRuntimeControlState,
  DAEMON_STATE_SCHEMA_VERSION,
  type DaemonState,
  JobStore,
  resolveDaemonPaths,
} from '@alembic/core/daemon';
import { pathGuard } from '@alembic/core/io';
import { PROJECT_SCOPE_CONTRACT_VERSION, type ProjectScopeSummary } from '@alembic/core/shared';
import {
  HnswVectorAdapter,
  RECIPE_REGION_VECTOR_ID_PREFIX,
  RECIPE_REGION_VECTOR_SCHEMA_VERSION,
  RECIPE_SEMANTIC_REGION_METADATA_TYPE,
} from '@alembic/core/vector';
import {
  getGhostWorkspaceDir,
  getProjectRegistryDir,
  ProjectRegistry,
} from '@alembic/core/workspace';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  getSavedProjectRootPath,
  readInitMarker,
  readSavedProjectRoot,
} from '../../lib/host-runtime/context/ProjectRootResolver.js';
import {
  getVisibleTools,
  HostMcpServer,
  resetPluginOwnedMcpServerForTests,
} from '../../lib/host-runtime/mcp/HostMcpServer.js';
import { buildMcpGuidance } from '../../lib/host-runtime/mcp/host/guidance.js';
import { resetStagingAccessSweepStateForTests } from '../../lib/host-runtime/mcp/host/staging-access-sweep.js';
import { serializeMcpToolResult } from '../../lib/host-runtime/mcp/output-contract.js';
import { resetServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { AlembicResidentServiceClient } from '../../lib/service/resident/AlembicResidentServiceClient.js';
import { getPackageVersion } from '../../lib/shared/package-assets.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const ORIGINAL_ALEMBIC_PROJECT_DIR = process.env.ALEMBIC_PROJECT_DIR;
const ORIGINAL_CODEX_ENABLE_ADMIN = process.env.ALEMBIC_CODEX_ENABLE_ADMIN;
const ORIGINAL_CODEX_WORKSPACE_DIR = process.env.CODEX_WORKSPACE_DIR;
const ORIGINAL_CODEX_WORKSPACE_ROOT = process.env.CODEX_WORKSPACE_ROOT;
const ORIGINAL_CODEX_PROJECT_SCOPE_SUMMARY = process.env.ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY;
const ORIGINAL_INIT_CWD = process.env.INIT_CWD;
const ORIGINAL_MCP_TIER = process.env.ALEMBIC_MCP_TIER;
const ORIGINAL_PWD = process.env.PWD;
const ORIGINAL_STAGING_SWEEP_MIN_INTERVAL_MS =
  process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS;
const ORIGINAL_STAGING_SWEEP_TIMEOUT_MS = process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS;
const ORIGINAL_LOCAL_EMBEDDING_ENABLED = process.env.ALEMBIC_LOCAL_EMBEDDING_ENABLED;
const ORIGINAL_OLLAMA_EMBED_MODEL = process.env.ALEMBIC_OLLAMA_EMBED_MODEL;
const ORIGINAL_OLLAMA_ENDPOINT = process.env.ALEMBIC_OLLAMA_ENDPOINT;
const ORIGINAL_RESIDENT_SEARCH_ENABLED = process.env.ALEMBIC_RESIDENT_SEARCH_ENABLED;
// 钉更新（2026-07-06）：alembic_plan 进 HOST_AGENT_WORKFLOW 可见面（plan→bootstrap
// 是冷启动必经）后本清单未同步——9 个既有失败中 3 个的根因；recipe_map 实际注册
// 顺序紧随 prime（同为知识消费首跳）。按 getVisibleTools 真实顺序对齐。
const CODEX_HOST_AGENT_TOOL_NAMES = [
  'alembic_plan',
  'alembic_submit_knowledge',
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_dimension_complete',
];
const TOOL_POLICY_AGENT_PUBLIC_TOOL_NAMES = ['alembic_prime', 'alembic_work', 'alembic_code_guard'];
const CODEX_SOURCE_GRAPH_TOOL_NAMES: string[] = [];
const CODEX_INITIALIZED_NO_KNOWLEDGE_TOOL_NAMES = [
  'alembic_prime',
  'alembic_recipe_map',
  'alembic_work',
  'alembic_code_guard',
  'alembic_search',
  'alembic_graph',
  'alembic_plan',
  'alembic_submit_knowledge',
  'alembic_project_skill',
  'alembic_bootstrap',
  'alembic_rescan',
  'alembic_dimension_complete',
];

function useTempAlembicHome(): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-codex-home-'));
  process.env.ALEMBIC_HOME = tempHome;
  return tempHome;
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-codex-project-'));
}

function makeInitializedWorkspace(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, '.asd'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.asd', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(projectRoot, '.asd', 'alembic.db'), '');
  fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'Alembic', 'skills'), { recursive: true });
}

function makeUsableKnowledgeBase(projectRoot: string): void {
  makeInitializedWorkspace(projectRoot);
  fs.writeFileSync(
    path.join(projectRoot, 'Alembic', 'recipes', 'http-client.md'),
    '---\ntitle: HTTP Client\n---\nUse the project HTTP client.\n'
  );
}

function writePlanFixtureSource(projectRoot: string, label = 'fixture'): void {
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify(
      {
        name: `host-mcp-${label}`,
        main: 'src/index.ts',
        scripts: { test: 'vitest run' },
        devDependencies: { typescript: '^5.0.0', vitest: '^4.0.0' },
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(projectRoot, 'src', 'index.ts'), `export const ${label} = 1;\n`);
}

function seedStagingRecipeRows(projectRoot: string, now: number): void {
  const db = new Database(path.join(projectRoot, '.asd', 'alembic.db'));
  try {
    const insert = db.prepare(
      `INSERT INTO knowledge_entries
        (id, title, description, lifecycle, autoApprovable, language, dimensionId,
         category, kind, knowledgeType, content, reasoning, quality, createdAt,
         updatedAt, staging_deadline)
       VALUES
        (?, ?, ?, 'staging', ?, 'typescript', 'architecture',
         'architecture', 'fact', 'code-pattern', '{}', ?, ?, ?, ?, ?)`
    );
    insert.run(
      'p1-due-auto',
      'Due Auto Recipe',
      'Due auto-approvable staging Recipe.',
      1,
      JSON.stringify({ sources: ['src/index.ts'], confidence: 0.95 }),
      JSON.stringify({ overall: 0.95 }),
      now - 10_000,
      now - 10_000,
      now - 1_000
    );
    insert.run(
      'p1-future-auto',
      'Future Auto Recipe',
      'Future auto-approvable staging Recipe.',
      1,
      JSON.stringify({ sources: ['src/index.ts'], confidence: 0.95 }),
      JSON.stringify({ overall: 0.95 }),
      now - 10_000,
      now - 10_000,
      now + 60_000
    );
    insert.run(
      'p1-due-manual',
      'Due Manual Recipe',
      'Due non-auto staging Recipe.',
      0,
      JSON.stringify({ sources: ['src/index.ts'], confidence: 0.95 }),
      JSON.stringify({ overall: 0.95 }),
      now - 10_000,
      now - 10_000,
      now - 1_000
    );
  } finally {
    db.close();
  }
}

function seedActiveSearchRecipe(projectRoot: string, id: string, title: string): void {
  const db = new Database(path.join(projectRoot, '.asd', 'alembic.db'));
  try {
    db.prepare(
      `INSERT INTO knowledge_entries
        (id, title, description, lifecycle, autoApprovable, language, dimensionId,
         category, kind, knowledgeType, content, reasoning, quality, createdAt, updatedAt)
       VALUES
        (?, ?, ?, 'active', 0, 'typescript', 'architecture',
         'architecture', 'fact', 'code-pattern', '{}', '{}', ?, ?, ?)`
    ).run(
      id,
      title,
      `${title} project-scoped guidance.`,
      JSON.stringify({ overall: 0.95 }),
      Date.now(),
      Date.now()
    );
  } finally {
    db.close();
  }
}

async function seedLocalSemanticRegion(
  projectRoot: string,
  input: { id: string; sourceRef: string; title: string; trigger: string }
): Promise<void> {
  const store = new HnswVectorAdapter(projectRoot, { walEnabled: false });
  store.initSync();
  await store.upsert({
    id: `${RECIPE_REGION_VECTOR_ID_PREFIX}${input.id}_identity_test`,
    content: `Recipe title: ${input.title}\nTrigger: ${input.trigger}\nSource refs: ${input.sourceRef}`,
    vector: [1, 0, 0],
    metadata: {
      dimensionId: 'architecture',
      generatedFrom: 'knowledge-entry-row',
      generationScope: 'test-fixture',
      kind: 'pattern',
      language: 'typescript',
      lifecycle: 'active',
      recipeId: input.id,
      regionClass: 'identity',
      schemaVersion: RECIPE_REGION_VECTOR_SCHEMA_VERSION,
      sourceRefs: [input.sourceRef],
      sourceRefsBridge: 'active',
      title: input.title,
      trigger: input.trigger,
      type: RECIPE_SEMANTIC_REGION_METADATA_TYPE,
    },
  });
  await store.flush();
  store.destroy();
}

function captureDatabaseFamily(
  dbPath: string
): Record<string, { exists: boolean; hash?: string; mtimeNs?: bigint; size?: number }> {
  return Object.fromEntries(
    ['', '-wal', '-shm'].map((suffix) => {
      const filePath = `${dbPath}${suffix}`;
      if (!fs.existsSync(filePath)) {
        return [suffix || 'main', { exists: false }];
      }
      const stat = fs.statSync(filePath, { bigint: true });
      return [
        suffix || 'main',
        {
          exists: true,
          hash: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
          mtimeNs: stat.mtimeNs,
          size: Number(stat.size),
        },
      ];
    })
  );
}

function captureReadOnlySearchInputs(
  projectRoot: string
): Record<string, { exists: boolean; hash?: string; mtimeNs?: bigint; size?: number }> {
  return Object.fromEntries(
    [
      ['config', path.join(projectRoot, '.asd', 'config.json')],
      ['vectorIndex', path.join(projectRoot, '.asd', 'context', 'index', 'vector_index.asvec')],
    ].map(([label, filePath]) => {
      if (!fs.existsSync(filePath)) {
        return [label, { exists: false }];
      }
      const stat = fs.statSync(filePath, { bigint: true });
      return [
        label,
        {
          exists: true,
          hash: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
          mtimeNs: stat.mtimeNs,
          size: Number(stat.size),
        },
      ];
    })
  );
}

function readStagingSweepRows(projectRoot: string): {
  events: Array<{
    from_state: string;
    operator_id: string;
    recipe_id: string;
    to_state: string;
    trigger: string;
  }>;
  recipes: Array<{
    autoApprovable: number;
    id: string;
    lifecycle: string;
    publishedBy: string | null;
    staging_deadline: number | null;
  }>;
} {
  const db = new Database(path.join(projectRoot, '.asd', 'alembic.db'), { readonly: true });
  try {
    return {
      recipes: db
        .prepare(
          `SELECT id, lifecycle, autoApprovable, publishedBy, staging_deadline
             FROM knowledge_entries
            WHERE id LIKE 'p1-%'
            ORDER BY id`
        )
        .all() as Array<{
        autoApprovable: number;
        id: string;
        lifecycle: string;
        publishedBy: string | null;
        staging_deadline: number | null;
      }>,
      events: db
        .prepare(
          `SELECT recipe_id, from_state, to_state, trigger, operator_id
             FROM lifecycle_transition_events
            ORDER BY created_at`
        )
        .all() as Array<{
        from_state: string;
        operator_id: string;
        recipe_id: string;
        to_state: string;
        trigger: string;
      }>,
    };
  } finally {
    db.close();
  }
}

async function confirmPlanForHostBootstrap(
  server: HostMcpServer,
  projectRoot: string
): Promise<{ dimensionId: string; planSelection: Record<string, unknown> }> {
  const draft = (await server.handleToolCall('alembic_plan', {
    operation: 'draft',
    projectRoot,
    hints: { maxBudget: 8 },
  })) as { data?: Record<string, unknown>; success: boolean };
  expect(draft.success).toBe(true);
  const guide = readRecord(draft.data?.projectContextCreationGuide);
  const boundaryDimensionIds = readArray(readRecord(guide.confirmedPlanBoundary).dimensionIds)
    .map((dimensionId) => (typeof dimensionId === 'string' ? dimensionId : undefined))
    .filter((dimensionId): dimensionId is string => Boolean(dimensionId));
  const candidateDimensionIds = readArray(draft.data?.candidateDimensions)
    .map((dimension) => {
      const id = readRecord(dimension).id;
      return typeof id === 'string' ? id : undefined;
    })
    .filter((dimensionId): dimensionId is string => Boolean(dimensionId));
  const dimensionIds =
    boundaryDimensionIds.length > 0 ? boundaryDimensionIds : candidateDimensionIds;
  if (dimensionIds.length === 0) {
    throw new Error('Expected alembic_plan draft fact package to include at least one dimension.');
  }
  const dimensionId = dimensionIds[0];
  const confirmed = (await server.handleToolCall('alembic_plan', {
    operation: 'confirm',
    projectRoot,
    generationStage: 'coldStart',
    projectProfile: {
      projectType: 'node-package',
      primaryLanguage: 'typescript',
      secondaryLanguages: [],
      frameworks: ['node'],
      moduleCount: 1,
      fileCount: 2,
    },
    selectedDimensions: dimensionIds.map((id, index) => ({
      dimensionId: id,
      priority: index + 1,
      rationale: 'HostMcpServer bootstrap fixture',
      targetRecipes: 1,
    })),
    scale: {
      totalRecipeBudget: dimensionIds.length,
      depthLevels: ['project'],
      maxFiles: 8,
      contentMaxLines: 24,
    },
    moduleBindings: [
      { modulePath: 'src', dimensions: dimensionIds, targetRecipes: 1, priority: 1 },
    ],
    plannedNextActions: [{ tool: 'alembic_bootstrap', reason: 'Run Plan-gated bootstrap.' }],
    evidenceRefs: [
      {
        kind: 'project-context',
        ref: String(draft.data?.projectContextSignature),
        detail: 'draft fact package signature',
      },
    ],
    rationale: 'HostMcpServer bootstrap fixture confirms a complete Plan payload.',
  })) as { data?: Record<string, unknown>; success: boolean };
  expect(confirmed.success).toBe(true);
  return { dimensionId, planSelection: readRecord(confirmed.data?.planSelection) };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function makeDirtyGitRepo(projectRoot: string): void {
  fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export const value = 1;\n');
  git(projectRoot, ['init']);
  git(projectRoot, ['config', 'user.email', 'test@example.com']);
  git(projectRoot, ['config', 'user.name', 'Alembic Test']);
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-m', 'init']);
  fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export const value = 2;\n');
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function writeRunningBootstrapJob(projectRoot: string): void {
  const jobsDir = path.join(projectRoot, '.asd', 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, 'bootstrap_active.json'),
    `${JSON.stringify(
      {
        id: 'bootstrap_active',
        kind: 'bootstrap',
        status: 'running',
        source: 'codex',
        channelId: 'codex',
        createdByTool: 'alembic_job',
        createdAt: '2026-05-24T08:00:00.000Z',
        updatedAt: '2026-05-24T08:01:00.000Z',
      },
      null,
      2
    )}\n`
  );
}

function writeRuntimeControlState(
  state: Parameters<typeof createProjectRuntimeControlState>[0]
): void {
  fs.mkdirSync(getProjectRegistryDir(), { recursive: true });
  fs.writeFileSync(
    path.join(getProjectRegistryDir(), 'runtime-control.json'),
    `${JSON.stringify(createProjectRuntimeControlState(state), null, 2)}\n`
  );
}

function makeDaemonState(projectRoot: string, overrides: Partial<DaemonState> = {}): DaemonState {
  const paths = resolveDaemonPaths(projectRoot);
  return {
    schemaVersion: DAEMON_STATE_SCHEMA_VERSION,
    projectRoot: paths.projectRoot,
    dataRoot: paths.dataRoot,
    projectId: paths.projectId,
    pid: 12345,
    host: '127.0.0.1',
    port: 39127,
    url: 'http://127.0.0.1:39127',
    dashboardUrl: 'http://127.0.0.1:39127',
    token: 'test-token',
    version: getPackageVersion(),
    mode: 'daemon',
    startedAt: '2026-05-08T00:00:00.000Z',
    lastReadyAt: '2026-05-08T00:00:01.000Z',
    databasePath: path.join(paths.runtimeDir, 'alembic.db'),
    schemaMigrationVersion: '001',
    ...overrides,
  };
}

function writeDaemonState(projectRoot: string, state: DaemonState = makeDaemonState(projectRoot)) {
  const paths = resolveDaemonPaths(projectRoot);
  fs.mkdirSync(path.dirname(paths.statePath), { recursive: true });
  fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function makeProjectScopeSummary(input: {
  controlRoot: string;
  currentFolderPath: string;
  dataRoot: string;
}): ProjectScopeSummary {
  return {
    contractVersion: PROJECT_SCOPE_CONTRACT_VERSION,
    controlRoot: input.controlRoot,
    controlRootIncludedInFolders: false,
    currentFolderId: 'folder-plugin',
    currentFolderPath: input.currentFolderPath,
    dataRoot: input.dataRoot,
    dataRootSource: 'ghost-registry',
    displayName: 'Alembic workspace',
    folderCount: 1,
    folders: [
      {
        displayName: 'AlembicPlugin',
        folderId: 'folder-plugin',
        path: input.currentFolderPath,
        realpath: input.currentFolderPath,
        repositoryId: 'alembic-plugin',
        role: 'source',
        state: 'active',
      },
    ],
    projectId: 'project-workspace',
    projectRootWriteAllowed: false,
    projectScopeId: 'project-scope-workspace',
    standardWriteAllowed: false,
    storageKind: 'ghost',
  };
}

function makeProjectScopeHealthPayload(projectScope: ProjectScopeSummary) {
  return {
    success: true,
    data: {
      residentService: createAlembicResidentServiceStatus({
        apiBaseUrl: 'http://127.0.0.1:39127',
        owner: 'alembic',
        route: 'local-alembic-daemon',
        capabilityOverrides: {
          'dashboard.handoff': { available: true, message: 'Dashboard handoff available.' },
          'jobs.api-ai.bootstrap': { available: true, message: 'Bootstrap jobs available.' },
          'jobs.api-ai.rescan': { available: true, message: 'Rescan jobs available.' },
          'search.keyword': { available: true, message: 'Keyword search available.' },
          'search.semantic': { available: true, message: 'Semantic search available.' },
          'status.health': { available: true, message: 'Health available.' },
        },
        serviceScope: {
          diagnosticPaths: {
            controlRoot: projectScope.controlRoot,
            databasePath: path.join(projectScope.dataRoot, '.asd', 'alembic.db'),
            dataRoot: projectScope.dataRoot,
            projectRoot: projectScope.currentFolderPath,
            runtimeDir: path.join(projectScope.dataRoot, '.asd', 'daemon'),
            statePath: path.join(projectScope.dataRoot, '.asd', 'daemon', 'state.json'),
          },
          displayName: projectScope.displayName,
          kind: 'current-project',
          projectIdentity: {
            dataRootSource: 'ghost-registry',
            projectId: projectScope.projectId,
            projectScope,
            projectScopeId: projectScope.projectScopeId,
            schemaMigrationVersion: null,
            workspaceMode: 'ghost',
          },
          scopeId: `project-scope:${projectScope.projectScopeId}`,
        },
      }),
    },
  };
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

afterEach(async () => {
  // Codex-facing tools now execute in the Plugin process, so tests must clear
  // per-project globals between temporary workspaces.
  await resetPluginOwnedMcpServerForTests();
  resetStagingAccessSweepStateForTests();
  resetServiceContainer();
  pathGuard._reset();
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  if (ORIGINAL_CODEX_ENABLE_ADMIN === undefined) {
    delete process.env.ALEMBIC_CODEX_ENABLE_ADMIN;
  } else {
    process.env.ALEMBIC_CODEX_ENABLE_ADMIN = ORIGINAL_CODEX_ENABLE_ADMIN;
  }
  if (ORIGINAL_ALEMBIC_PROJECT_DIR === undefined) {
    delete process.env.ALEMBIC_PROJECT_DIR;
  } else {
    process.env.ALEMBIC_PROJECT_DIR = ORIGINAL_ALEMBIC_PROJECT_DIR;
  }
  if (ORIGINAL_CODEX_WORKSPACE_DIR === undefined) {
    delete process.env.CODEX_WORKSPACE_DIR;
  } else {
    process.env.CODEX_WORKSPACE_DIR = ORIGINAL_CODEX_WORKSPACE_DIR;
  }
  if (ORIGINAL_CODEX_WORKSPACE_ROOT === undefined) {
    delete process.env.CODEX_WORKSPACE_ROOT;
  } else {
    process.env.CODEX_WORKSPACE_ROOT = ORIGINAL_CODEX_WORKSPACE_ROOT;
  }
  if (ORIGINAL_CODEX_PROJECT_SCOPE_SUMMARY === undefined) {
    delete process.env.ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY;
  } else {
    process.env.ALEMBIC_CODEX_PROJECT_SCOPE_SUMMARY = ORIGINAL_CODEX_PROJECT_SCOPE_SUMMARY;
  }
  if (ORIGINAL_INIT_CWD === undefined) {
    delete process.env.INIT_CWD;
  } else {
    process.env.INIT_CWD = ORIGINAL_INIT_CWD;
  }
  if (ORIGINAL_MCP_TIER === undefined) {
    delete process.env.ALEMBIC_MCP_TIER;
  } else {
    process.env.ALEMBIC_MCP_TIER = ORIGINAL_MCP_TIER;
  }
  if (ORIGINAL_PWD === undefined) {
    delete process.env.PWD;
  } else {
    process.env.PWD = ORIGINAL_PWD;
  }
  if (ORIGINAL_STAGING_SWEEP_MIN_INTERVAL_MS === undefined) {
    delete process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS;
  } else {
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS =
      ORIGINAL_STAGING_SWEEP_MIN_INTERVAL_MS;
  }
  if (ORIGINAL_STAGING_SWEEP_TIMEOUT_MS === undefined) {
    delete process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS;
  } else {
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS = ORIGINAL_STAGING_SWEEP_TIMEOUT_MS;
  }
  if (ORIGINAL_LOCAL_EMBEDDING_ENABLED === undefined) {
    delete process.env.ALEMBIC_LOCAL_EMBEDDING_ENABLED;
  } else {
    process.env.ALEMBIC_LOCAL_EMBEDDING_ENABLED = ORIGINAL_LOCAL_EMBEDDING_ENABLED;
  }
  if (ORIGINAL_OLLAMA_EMBED_MODEL === undefined) {
    delete process.env.ALEMBIC_OLLAMA_EMBED_MODEL;
  } else {
    process.env.ALEMBIC_OLLAMA_EMBED_MODEL = ORIGINAL_OLLAMA_EMBED_MODEL;
  }
  if (ORIGINAL_OLLAMA_ENDPOINT === undefined) {
    delete process.env.ALEMBIC_OLLAMA_ENDPOINT;
  } else {
    process.env.ALEMBIC_OLLAMA_ENDPOINT = ORIGINAL_OLLAMA_ENDPOINT;
  }
  if (ORIGINAL_RESIDENT_SEARCH_ENABLED === undefined) {
    delete process.env.ALEMBIC_RESIDENT_SEARCH_ENABLED;
  } else {
    process.env.ALEMBIC_RESIDENT_SEARCH_ENABLED = ORIGINAL_RESIDENT_SEARCH_ENABLED;
  }
  vi.restoreAllMocks();
});

describe('HostMcpServer', () => {
  test('lists Codex local tools alongside agent-tier Alembic tools', () => {
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const tools = getVisibleTools('agent', projectRoot);
    const names = tools.map((tool) => tool.name);

    expect(names).not.toContain(['alembic', 'codex', 'ai', 'config'].join('_'));
    expect(names).toContain('alembic_job');
    expect(names).toContain('alembic_runtime');
    expect(names).toContain('alembic_bootstrap');
    expect(names).toContain('alembic_rescan');
    expect(names).toContain('alembic_project_skill');
    expect(names).toContain('alembic_status');
    expect(names).not.toContain('alembic_knowledge_lifecycle');
  });

  test('builds initialize guidance from the visible Codex tool catalog', () => {
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const server = new HostMcpServer({ projectRoot });
    const instructions = server.getInitializeInstructions();

    expect(instructions).toContain('`alembic_recipe_map`');
    expect(instructions).toContain('`alembic_graph`');
    expect(instructions).toContain('`alembic_search`');
    expect(instructions).toContain('`alembic_code_guard`');
    expect(instructions).toContain('`bootstrapState`');
    expect(instructions).toContain('`currentDimensionGuidance`');
    expect(instructions).toContain('`hostAgentContract`');
    expect(instructions).toContain('`toolCapabilities`');
    expect(instructions).not.toContain('`currentDomainSop`');
    expect(instructions).not.toContain('`domainQueue`');
    expect(instructions).not.toContain('`sopPack`');
    expect(instructions).toContain('Project knowledge consumption');
    expect(instructions).toContain('call `alembic_search` first');
    expect(instructions).toContain('raw file reads/search');
    expect(instructions).toContain('Validation is still required');
  });

  test('does not advertise retired source graph tools in initialize guidance', () => {
    const guidance = buildMcpGuidance([
      { name: 'alembic_source_graph_status' },
      { name: 'alembic_code_explore' },
      { name: 'alembic_recipe_map' },
      { name: 'alembic_graph' },
      { name: 'alembic_prime' },
    ]);

    expect(guidance.knowledgeTools).toEqual(
      expect.arrayContaining(['alembic_recipe_map', 'alembic_graph'])
    );
    expect(guidance.instructions).toContain('`alembic_recipe_map`');
    expect(guidance.instructions).toContain('`alembic_graph`');
    expect(guidance.instructions).not.toContain('alembic_source_graph_status');
    expect(guidance.instructions).not.toContain('alembic_code_explore');
    expect(guidance.instructions).not.toContain('alembic_symbol_search');
    expect(guidance.instructions).not.toContain('alembic_callers');
    expect(guidance.instructions).not.toContain('alembic_affected_tests');
    expect(guidance.instructions).not.toContain('alembic_validation_plan');
  });

  test('keeps ProjectContext tool-list descriptions aligned with initialize guidance', () => {
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const byName = new Map(getVisibleTools('agent', projectRoot).map((tool) => [tool.name, tool]));

    expect(byName.get('alembic_recipe_map')?.description).toContain('ProjectContext');
    expect(byName.get('alembic_graph')?.description).toContain('ProjectContext');
    expect(byName.has('alembic_source_graph_status')).toBe(false);
    expect(byName.has('alembic_code_explore')).toBe(false);
    expect(byName.has('alembic_symbol_search')).toBe(false);
  });

  test('exposes MCP tool annotations so clients can reduce approval prompts', () => {
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const tools = getVisibleTools('agent', projectRoot);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(tools.every((tool) => tool.annotations)).toBe(true);
    expect(byName.get('alembic_status')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get('alembic_job')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(byName.get('alembic_runtime')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  test('exposes cold-start and init-on-demand tools before workspace initialization', () => {
    const projectRoot = makeProjectRoot();
    const names = getVisibleTools('agent', projectRoot).map((tool) => tool.name);

    expect(names).toEqual([
      'alembic_status',
      ...CODEX_SOURCE_GRAPH_TOOL_NAMES,
      'alembic_init',
      'alembic_job',
      ...TOOL_POLICY_AGENT_PUBLIC_TOOL_NAMES,
      ...CODEX_HOST_AGENT_TOOL_NAMES,
    ]);
  });

  test('exposes cold-start plus Codex host-agent workflow tools when initialized workspace has no usable knowledge', () => {
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const names = getVisibleTools('agent', projectRoot).map((tool) => tool.name);

    expect(names).toEqual([
      'alembic_status',
      ...CODEX_SOURCE_GRAPH_TOOL_NAMES,
      'alembic_init',
      'alembic_job',
      ...CODEX_INITIALIZED_NO_KNOWLEDGE_TOOL_NAMES,
    ]);
    expect(names).not.toContain('alembic_health');
    // alembic_search 在无知识阶段有意可见（INITIALIZED_PUBLIC_READ：零结果信封+引导有价值）
    expect(names).not.toContain('alembic_guard');
    expect(names).not.toContain('alembic_skill');
  });

  test('exposes resident-backed tools for ProjectScope resident even when local folder knowledge is empty', () => {
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const names = getVisibleTools('agent', projectRoot, {
      residentProjectScopeAvailable: true,
    }).map((tool) => tool.name);

    expect(names).toContain('alembic_search');
    expect(names).toContain('alembic_status');
    expect(names).not.toContain('alembic_task');
    expect(names).not.toContain('alembic_skill');
  });

  test('executes ProjectScope resident-backed tools from an excluded source folder without source writes', async () => {
    useTempAlembicHome();
    const controlRoot = makeProjectRoot();
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'AlembicPlugin-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-project-scope-data-'));
    fs.writeFileSync(
      path.join(sourceRoot, 'package.json'),
      `${JSON.stringify({ name: '@alembic/plugin' }, null, 2)}\n`
    );
    makeInitializedWorkspace(dataRoot);
    writeDaemonState(controlRoot);
    const projectScope = makeProjectScopeSummary({
      controlRoot,
      currentFolderPath: sourceRoot,
      dataRoot,
    });
    writeRuntimeControlState({
      activeProjectId: projectScope.projectId,
      activeProjectRoot: controlRoot,
      selectedAt: '2026-05-25T00:00:00.000Z',
      selectedProjectId: projectScope.projectId,
      selectedProjectRoot: controlRoot,
      updatedAt: '2026-05-25T00:00:00.000Z',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = fetchInputUrl(input);
      if (url.pathname === '/api/v1/daemon/health') {
        return new Response(JSON.stringify(makeProjectScopeHealthPayload(projectScope)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/api/v1/project-scope/resolve-folder') {
        expect(url.searchParams.get('folderPath')).toBe(sourceRoot);
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              capability: { available: true, storageKind: 'ghost' },
              summary: projectScope,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.pathname === '/api/v1/search') {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              items: [
                {
                  id: 'scope-recipe',
                  title: 'ProjectScope recipe',
                  trigger: '@project-scope',
                  kind: 'pattern',
                  language: 'typescript',
                  score: 0.94,
                  description: 'Use ProjectScope resident knowledge.',
                },
              ],
              searchMeta: {
                route: 'resident-search',
                requestedMode: url.searchParams.get('mode'),
                actualMode: 'semantic',
                semanticUsed: true,
                vectorUsed: true,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected resident request: ${url.toString()}`);
    });
    const server = new HostMcpServer({ projectRoot: sourceRoot });

    // MTC-4: alembic_status (default) is the cold-start local status; it reports the
    // resolved project read-only and never runs the old alembic_health resident-backed
    // execution wrapper (codexProjectScopeExecution), per "cold-start does not touch
    // resident-only". The resident-backed knowledge tools below (search/prime) remain.
    const statusResult = (await server.handleToolCall('alembic_status', {})) as {
      data: { project: { root: string } };
      success: boolean;
    };
    const searchResult = (await server.handleToolCall('alembic_search', {
      query: 'ProjectScope recipe',
      mode: 'auto',
      limit: 1,
    })) as {
      structuredContent: {
        ok: boolean;
        result: { residentSearch: { projectScopeIdentity: { projectScopeId: string } } };
      };
    };
    const primeResult = (await server.handleToolCall('alembic_prime', {
      // 钉更新（2026-07-06）：GMAP-8 后 prime 为 standalone 形态（taskAction+
      // requirementGoal 必填），旧 hostDeclaredIntent intent-route 输入已退役。
      taskAction: 'implement',
      requirementGoal: 'Use ProjectScope recipe',
      capability: 'project scope recipes',
      inputSource: 'host-declared-intent',
      language: 'typescript',
    })) as {
      ok: boolean;
      primePackage: {
        trustReceipt: { status: string };
      };
      status: string;
    };

    expect(statusResult.success).toBe(true);
    expect(statusResult.data.project.root).toBe(sourceRoot);
    expect(searchResult.structuredContent.ok).toBe(true);
    expect(searchResult.structuredContent.result.residentSearch.projectScopeIdentity).toMatchObject(
      {
        projectScopeId: projectScope.projectScopeId,
      }
    );
    expect(primeResult.ok).toBe(true);
    expect(['ready', 'degraded']).toContain(primeResult.status);
    // Prime quality-layering (a6bf70c): 'degraded' means the search PROCESS
    // failed/was blocked; 'empty' means the search SUCCEEDED but delivered no
    // trusted material. This mock's resident items carry no trust evidence
    // (no primeInjectionPackage / evidenceRefs), so they are honestly filtered
    // out and the receipt is 'empty' — the intended no-trusted-material result.
    expect(primeResult.primePackage.trustReceipt.status).toBe('empty');
    expect(fs.existsSync(path.join(sourceRoot, '.asd'))).toBe(false);
    expect(fs.existsSync(path.join(sourceRoot, 'Alembic'))).toBe(false);
    expect(fetchSpy).toHaveBeenCalled();
  });

  test('alembic_status (aspect=runtime) exposes daemon-less runtime-control policy read-only (PDR-3: sourceOfTruth null)', async () => {
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_status', { aspect: 'runtime' })) as {
      data: {
        projectRuntime: {
          blockedFallbacks: string[];
          fallbackIsolation: Array<{ effectiveIdentityAllowed: boolean; id: string }>;
          requiredServices: Array<{ reason: string | null; service: string; source: string }>;
          sourceOfTruth: {
            readiness: { reasonCode: string };
            runtimeControl: {
              diagnostics: Array<{ code: string; reasonCode: string }>;
              stateCleanup: {
                activeState: {
                  cleaned: boolean;
                  previousProjectId: string | null;
                  reasonCode: string | null;
                };
              };
            };
          };
          sourcePolicy: { selectedOrActiveCanOverrideEffectiveIdentity: boolean };
        };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    // PDR-3: the embedded plugin daemon was removed, so no daemon-borne
    // projectRuntimeSourceOfTruth is carried into the plugin — sourceOfTruth is
    // null. (The stale-active-state cleanup diagnostics were a daemon-era
    // feature; they live on in the main-body daemon, not in the plugin host.)
    // The runtime-control POLICY surface below (requiredServices / sourcePolicy
    // / blockedFallbacks / fallbackIsolation) is daemon-independent and remains.
    expect(result.data.projectRuntime.sourceOfTruth).toBeNull();
    // PDR-3: requiredServices no longer carries a resident `daemon` service.
    // The daemon-less runtime reports project-identity ready (from the current
    // Codex project) and project-scope degraded with the explicit removal
    // reason — the honest post-PDR-3 required-services shape.
    expect(result.data.projectRuntime.requiredServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: 'project-identity',
          source: 'codex-current-project',
          state: 'ready',
        }),
        expect.objectContaining({
          service: 'project-scope',
          source: 'plugin-single-folder-baseline',
          reason: 'project-scope-unavailable',
        }),
      ])
    );
    expect(result.data.projectRuntime.sourcePolicy).toMatchObject({
      selectedOrActiveCanOverrideEffectiveIdentity: false,
    });
    expect(result.data.projectRuntime.blockedFallbacks).toContain(
      'runtime-control-selected-active-effective-identity'
    );
    expect(result.data.projectRuntime.fallbackIsolation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effectiveIdentityAllowed: false,
          id: 'runtime-control-selected-active',
        }),
      ])
    );
  });

  test('keeps project skill delivery visible while initialized knowledge is not usable and bootstrap is running', async () => {
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    writeRunningBootstrapJob(projectRoot);

    const names = getVisibleTools('agent', projectRoot).map((tool) => tool.name);

    expect(names).toContain('alembic_project_skill');
    expect(names).not.toContain('alembic_skill');
    expect(names).not.toContain('alembic_health');

    const server = new HostMcpServer({ projectRoot });
    const result = (await server.handleToolCall('alembic_project_skill', {
      operation: 'list',
    })) as {
      data?: { codexRuntime?: { root?: string }; replacementFor?: string };
      success?: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data?.replacementFor).toBeUndefined();
    expect(result.data?.codexRuntime?.root).toBe(path.join(projectRoot, '.agents', 'skills'));
  });

  test('detects usable knowledge from the registered ghost data root', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const ghostRoot = getGhostWorkspaceDir(entry.id);
    makeInitializedWorkspace(ghostRoot);
    fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'Alembic', 'recipes', 'project-tree-should-not-count.md'),
      '# Ignored Project Tree Recipe\n'
    );

    expect(getVisibleTools('agent', projectRoot).map((tool) => tool.name)).toEqual([
      'alembic_status',
      ...CODEX_SOURCE_GRAPH_TOOL_NAMES,
      'alembic_init',
      'alembic_job',
      ...CODEX_INITIALIZED_NO_KNOWLEDGE_TOOL_NAMES,
    ]);
    expect(getVisibleTools('agent', projectRoot).map((tool) => tool.name)).not.toContain(
      'alembic_skill'
    );

    fs.writeFileSync(
      path.join(ghostRoot, 'Alembic', 'recipes', 'ghost-recipe.md'),
      '# Ghost Recipe\n'
    );

    const names = getVisibleTools('agent', projectRoot).map((tool) => tool.name);

    expect(names).not.toContain('alembic_task');
    expect(names).toContain('alembic_status');
  });

  test('requires a second Codex admin opt-in before exposing admin-tier tools', () => {
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    process.env.ALEMBIC_MCP_TIER = 'admin';
    delete process.env.ALEMBIC_CODEX_ENABLE_ADMIN;

    expect(getVisibleTools(undefined, projectRoot).map((tool) => tool.name)).not.toContain(
      'alembic_knowledge_lifecycle'
    );

    process.env.ALEMBIC_CODEX_ENABLE_ADMIN = '1';

    expect(getVisibleTools(undefined, projectRoot).map((tool) => tool.name)).toContain(
      'alembic_knowledge_lifecycle'
    );
  });

  test('status inspects workspace and daemon state without ensuring daemon startup', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_status', {})) as {
      success: boolean;
      data: {
        initialized: boolean;
        daemon: { ready: boolean };
        localEmbedding: {
          enabled: boolean;
          endpoint: string;
          model: string;
          provider: string;
          setup: {
            enableConfig: string;
            enableEnv: string;
            guidance: string[];
            pullCommand: string;
          };
        };
        nextActions: string[];
        onboarding: {
          primaryAction: { startsDaemon: boolean; tool: string };
          state: string;
        };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.initialized).toBe(false);
    expect(result.data.daemon.ready).toBe(false);
    expect(result.data.localEmbedding).toMatchObject({
      enabled: false,
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen3-embedding',
      provider: 'ollama',
      setup: {
        enableConfig: 'vector.localEmbedding.enabled=true',
        enableEnv: 'ALEMBIC_LOCAL_EMBEDDING_ENABLED=1',
        pullCommand: 'ollama pull qwen3-embedding',
      },
    });
    expect(result.data.localEmbedding.setup.guidance.join('\n')).toContain(
      'ALEMBIC_LOCAL_EMBEDDING_ENABLED=1'
    );
    expect(result.data.onboarding).toMatchObject({
      state: 'needs_init',
      primaryAction: { startsDaemon: false, tool: 'alembic_init' },
    });
    expect(result.data.nextActions).toContain('Initialize Ghost workspace: call alembic_init');
    expect(result.data.nextActions).not.toContain(
      'Plan cold-start after init: call alembic_bootstrap'
    );
  });

  test('status shows bootstrap guidance for sourceful uninitialized projects without creating jobs', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    writePlanFixtureSource(projectRoot, 'statusSourceful');
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_status', {})) as {
      success: boolean;
      data: {
        nextActions: string[];
        onboarding: {
          nextActions: Array<{ startsDaemon: boolean; tool: string }>;
          primaryAction: { reason: string; startsDaemon: boolean; tool: string };
          sourcePresence: { hasSource: boolean; sourceFileCount: number };
          state: string;
        };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.onboarding).toMatchObject({
      state: 'needs_init',
      primaryAction: { startsDaemon: false, tool: 'alembic_init' },
      sourcePresence: { hasSource: true },
    });
    expect(result.data.onboarding.primaryAction.reason).toContain('does not run it');
    expect(result.data.onboarding.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          startsDaemon: false,
          tool: 'alembic_bootstrap',
        }),
      ])
    );
    expect(result.data.nextActions).toContain('Plan cold-start after init: call alembic_bootstrap');
    expect(fs.existsSync(path.join(projectRoot, '.asd', 'jobs'))).toBe(false);
  });

  test('status exposes session-level per-tool usage counts', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const server = new HostMcpServer({ projectRoot });

    await server.handleToolCall('alembic_prime', {
      taskAction: 'implement',
      requirementGoal: 'Use project Recipe context before editing',
      capability: 'project knowledge',
      inputSource: 'host-declared-intent',
      language: 'typescript',
    });
    await server.handleToolCall('alembic_search', { query: 'HTTP Client', limit: 1 });
    await server.handleToolCall('alembic_search', { query: 'project HTTP client', limit: 1 });

    const result = (await server.handleToolCall('alembic_status', {})) as {
      success: boolean;
      data: {
        session: { toolCallCount: number; toolsUsed: string[] };
        usage: {
          byTool: {
            graph: { count: number; lastCalledAt: number | null };
            prime: { count: number; lastCalledAt: number | null };
            recipeMap: { count: number; lastCalledAt: number | null };
            search: { count: number; lastCalledAt: number | null };
          };
        };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.session.toolCallCount).toBe(3);
    expect(result.data.session.toolsUsed).toEqual(['alembic_prime', 'alembic_search']);
    expect(result.data.usage.byTool.prime).toMatchObject({
      count: 1,
      lastCalledAt: expect.any(Number),
    });
    expect(result.data.usage.byTool.search).toMatchObject({
      count: 2,
      lastCalledAt: expect.any(Number),
    });
    expect(result.data.usage.byTool.recipeMap).toEqual({ count: 0, lastCalledAt: null });
    expect(result.data.usage.byTool.graph).toEqual({ count: 0, lastCalledAt: null });
  });

  test('tool-call projectRoot override scopes status to the requested project', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'gxfn',
      'alembic',
      getPackageVersion()
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;

    const projectRoot = makeProjectRoot();
    const server = new HostMcpServer();

    const result = (await server.handleToolCall('alembic_status', { projectRoot })) as {
      data: {
        project: { root: string; trust: string; trusted: boolean };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data.project).toMatchObject({
      root: projectRoot,
      trust: 'trusted',
      trusted: true,
    });
  });

  test('tool-call projectRoot override scopes search project identity to the requested project', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'gxfn',
      'alembic',
      getPackageVersion()
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;

    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const server = new HostMcpServer();

    const result = (await server.handleToolCall('alembic_search', {
      projectRoot,
      query: 'http client',
      limit: 1,
    })) as {
      structuredContent: { ok: boolean };
    };

    // GMAP-8b relocated project identity off the strict alembic_search output
    // (no top-level `project`; resident scope identity lives under
    // result.residentSearch.projectScopeIdentity). The tool-call projectRoot
    // override is verified through the shared resolution surface: the search
    // executes (ok) under the override, and alembic_status with the same
    // override arg resolves to the requested project root — proving the arg
    // override (not PWD=pluginRoot) drove identity resolution.
    expect(result.structuredContent.ok).toBe(true);
    const overrideStatus = (await server.handleToolCall('alembic_status', {
      projectRoot,
    })) as { data: { project: { root: string } }; success: boolean };
    expect(overrideStatus.success).toBe(true);
    expect(overrideStatus.data.project.root).toBe(projectRoot);
  });

  test('one long-lived host server keeps sequential Search isolated without mutating database sidecars', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'gxfn',
      'alembic',
      getPackageVersion()
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;

    const workspaceRoot = makeProjectRoot();
    const bilidiliRoot = makeProjectRoot();
    makeUsableKnowledgeBase(workspaceRoot);
    makeUsableKnowledgeBase(bilidiliRoot);
    const server = new HostMcpServer();

    // Initialize each isolated temp knowledge store before inserting deterministic active rows.
    await server.handleToolCall('alembic_status', {
      projectRoot: workspaceRoot,
    });
    await server.handleToolCall('alembic_status', {
      projectRoot: bilidiliRoot,
    });
    seedActiveSearchRecipe(workspaceRoot, 'workspace-only', 'Workspace Only Recipe');
    seedActiveSearchRecipe(bilidiliRoot, 'bilidili-only', 'BiliDili Only Recipe');
    await seedLocalSemanticRegion(workspaceRoot, {
      id: 'workspace-only',
      sourceRef: 'Alembic/recipes/architecture/workspace-only.md',
      title: 'Workspace Only Recipe',
      trigger: '@workspace-only',
    });
    await seedLocalSemanticRegion(bilidiliRoot, {
      id: 'bilidili-only',
      sourceRef: 'Alembic/recipes/testing-quality/bilidili-only.md',
      title: 'BiliDili Only Recipe',
      trigger: '@bilidili-only',
    });

    await resetPluginOwnedMcpServerForTests();
    process.env.ALEMBIC_LOCAL_EMBEDDING_ENABLED = '1';
    process.env.ALEMBIC_OLLAMA_EMBED_MODEL = 'qwen3-embedding:0.6b';
    process.env.ALEMBIC_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
    process.env.ALEMBIC_RESIDENT_SEARCH_ENABLED = '0';
    let workspaceResidentAttempts = 0;
    const residentSearchSpy = vi
      .spyOn(AlembicResidentServiceClient.prototype, 'search')
      .mockImplementation(async (request) => {
        if (request.projectRoot !== workspaceRoot) {
          return {
            items: [],
            meta: {
              attempted: true,
              available: false,
              durationMs: 0,
              reason: 'resident-unavailable',
              requestedMode: request.mode ?? 'auto',
              residentVector: { available: false, reason: 'resident-unavailable' },
              resultCount: 0,
              route: 'alembic-resident-service',
              used: false,
            },
          };
        }
        workspaceResidentAttempts += 1;
        if (workspaceResidentAttempts === 1) {
          return {
            items: [],
            meta: {
              attempted: true,
              available: false,
              durationMs: 0,
              reason: 'request-timeout',
              requestedMode: request.mode ?? 'auto',
              residentVector: { available: false, reason: 'request-timeout' },
              resultCount: 0,
              route: 'alembic-resident-service',
              used: false,
            },
          };
        }
        return {
          items: [
            {
              description: 'Result only contributed by the fluctuating resident lane.',
              id: 'resident-only',
              kind: 'pattern',
              language: 'typescript',
              metadata: { sourceRefs: ['resident-only.md'] },
              score: 0.99,
              sourceRefs: ['resident-only.md'],
              title: 'Resident Only Recipe',
            },
          ],
          meta: {
            actualMode: 'semantic',
            attempted: true,
            available: true,
            durationMs: 1,
            requestedMode: request.mode ?? 'auto',
            residentVector: { available: true, semanticUsed: true, vectorUsed: true },
            resultCount: 1,
            route: 'alembic-resident-service',
            semanticUsed: true,
            used: true,
            vectorUsed: true,
          },
        };
      });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:11434/api/tags') {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3-embedding:0.6b' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'http://127.0.0.1:11434/api/embed') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown[] };
        return new Response(
          JSON.stringify({ embeddings: (body.input ?? []).map(() => [1, 0, 0]) }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`resident unavailable for ${url}`);
    });
    const workspaceDbPath = path.join(workspaceRoot, '.asd', 'alembic.db');
    const bilidiliDbPath = path.join(bilidiliRoot, '.asd', 'alembic.db');
    // Keep both WAL families resident while the public host alternates projects, matching the
    // real daemon-owned stores from the controller reproduction. Capture after anchor setup so
    // only the four public Search calls are allowed to differ.
    const anchors = [new Database(workspaceDbPath), new Database(bilidiliDbPath)];
    for (const anchor of anchors) {
      anchor.pragma('journal_mode = WAL');
      anchor.prepare('SELECT COUNT(*) FROM knowledge_entries').get();
    }
    const databaseFamilyBefore = {
      bilidili: captureDatabaseFamily(bilidiliDbPath),
      workspace: captureDatabaseFamily(workspaceDbPath),
    };
    const searchInputsBefore = {
      bilidili: captureReadOnlySearchInputs(bilidiliRoot),
      workspace: captureReadOnlySearchInputs(workspaceRoot),
    };

    const workspaceRejectsBili = (await server.handleToolCall('alembic_search', {
      projectRoot: workspaceRoot,
      query: 'BiliDili Only Recipe',
      mode: 'keyword',
      limit: 5,
    })) as {
      structuredContent: { items: Array<{ id: string }> };
    };
    const bilidiliSearch = (await server.handleToolCall('alembic_search', {
      projectRoot: bilidiliRoot,
      query: 'BiliDili Only Recipe',
      mode: 'keyword',
      limit: 5,
    })) as {
      structuredContent: {
        items: Array<{ id: string }>;
        result: { requestProjectIdentity: { dataRoot: string; projectRoot: string } };
      };
    };
    const workspaceSearch = (await server.handleToolCall('alembic_search', {
      projectRoot: workspaceRoot,
      query: 'Workspace Only Recipe',
      mode: 'keyword',
      limit: 5,
    })) as {
      structuredContent: {
        items: Array<{ id: string }>;
        result: { requestProjectIdentity: { dataRoot: string; projectRoot: string } };
      };
    };
    const bilidiliRejectsWorkspace = (await server.handleToolCall('alembic_search', {
      projectRoot: bilidiliRoot,
      query: 'Workspace Only Recipe',
      mode: 'keyword',
      limit: 5,
    })) as {
      structuredContent: { items: Array<{ id: string }> };
    };
    const workspaceSemantic = (await server.handleToolCall('alembic_search', {
      projectRoot: workspaceRoot,
      query: 'distributed orchestration handoff',
      mode: 'semantic',
      limit: 5,
    })) as {
      structuredContent: {
        inventory: { candidateSources: string[] };
        items: Array<{ id: string; sourceRefs?: string[] }>;
        result: { requestProjectIdentity: { dataRoot: string; projectRoot: string } };
      };
    };
    const bilidiliSemantic = (await server.handleToolCall('alembic_search', {
      projectRoot: bilidiliRoot,
      query: 'swift cursor prefetch',
      mode: 'semantic',
      limit: 5,
    })) as typeof workspaceSemantic;
    const workspaceSemanticRepeat = (await server.handleToolCall('alembic_search', {
      projectRoot: workspaceRoot,
      query: 'distributed orchestration handoff',
      mode: 'semantic',
      limit: 5,
    })) as typeof workspaceSemantic;
    const bilidiliSemanticRepeat = (await server.handleToolCall('alembic_search', {
      projectRoot: bilidiliRoot,
      query: 'swift cursor prefetch',
      mode: 'semantic',
      limit: 5,
    })) as typeof workspaceSemantic;

    await resetPluginOwnedMcpServerForTests();
    const databaseFamilyAfter = {
      bilidili: captureDatabaseFamily(bilidiliDbPath),
      workspace: captureDatabaseFamily(workspaceDbPath),
    };
    const searchInputsAfter = {
      bilidili: captureReadOnlySearchInputs(bilidiliRoot),
      workspace: captureReadOnlySearchInputs(workspaceRoot),
    };
    for (const anchor of anchors) {
      anchor.close();
    }

    expect(workspaceRejectsBili.structuredContent.items.map((item) => item.id)).not.toContain(
      'bilidili-only'
    );
    expect(workspaceSearch.structuredContent.items.map((item) => item.id)).toContain(
      'workspace-only'
    );
    expect(workspaceSearch.structuredContent.items.map((item) => item.id)).not.toContain(
      'bilidili-only'
    );
    expect(bilidiliSearch.structuredContent.items.map((item) => item.id)).toContain(
      'bilidili-only'
    );
    expect(bilidiliSearch.structuredContent.items.map((item) => item.id)).not.toContain(
      'workspace-only'
    );
    expect(bilidiliRejectsWorkspace.structuredContent.items.map((item) => item.id)).not.toContain(
      'workspace-only'
    );
    expect(workspaceSearch.structuredContent.result.requestProjectIdentity).toMatchObject({
      dataRoot: workspaceRoot,
      projectRoot: workspaceRoot,
    });
    expect(bilidiliSearch.structuredContent.result.requestProjectIdentity).toMatchObject({
      dataRoot: bilidiliRoot,
      projectRoot: bilidiliRoot,
    });
    expect(workspaceSemantic.structuredContent.items.map((item) => item.id)).toEqual([
      'workspace-only',
    ]);
    expect(workspaceSemantic.structuredContent.items[0]?.sourceRefs).toContain(
      'Alembic/recipes/architecture/workspace-only.md'
    );
    expect(
      workspaceSemantic.structuredContent.items.flatMap((item) => item.sourceRefs ?? [])
    ).not.toContain('Alembic/recipes/testing-quality/bilidili-only.md');
    expect(workspaceSemantic.structuredContent.inventory.candidateSources).toContain(
      'local-recipe-region-vector'
    );
    expect(bilidiliSemantic.structuredContent.items.map((item) => item.id)).toEqual([
      'bilidili-only',
    ]);
    expect(bilidiliSemantic.structuredContent.items[0]?.sourceRefs).toContain(
      'Alembic/recipes/testing-quality/bilidili-only.md'
    );
    expect(
      bilidiliSemantic.structuredContent.items.flatMap((item) => item.sourceRefs ?? [])
    ).not.toContain('Alembic/recipes/architecture/workspace-only.md');
    expect(workspaceSemanticRepeat.structuredContent.items).toEqual(
      workspaceSemantic.structuredContent.items
    );
    expect(bilidiliSemanticRepeat.structuredContent.items).toEqual(
      bilidiliSemantic.structuredContent.items
    );
    expect(residentSearchSpy).not.toHaveBeenCalled();
    expect(workspaceSemantic.structuredContent.result.requestProjectIdentity).toMatchObject({
      dataRoot: workspaceRoot,
      projectRoot: workspaceRoot,
    });
    expect(bilidiliSemantic.structuredContent.result.requestProjectIdentity).toMatchObject({
      dataRoot: bilidiliRoot,
      projectRoot: bilidiliRoot,
    });
    expect(databaseFamilyAfter).toEqual(databaseFamilyBefore);
    expect(searchInputsAfter).toEqual(searchInputsBefore);
  });

  test('read-only projectRoot override does not persist diagnostics or become effective identity', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'gxfn',
      'alembic',
      getPackageVersion()
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.INIT_CWD = pluginRoot;
    process.env.PWD = pluginRoot;

    const projectRoot = makeProjectRoot();
    const firstServer = new HostMcpServer();
    await firstServer.handleToolCall('alembic_status', { projectRoot });

    const secondServer = new HostMcpServer();
    const result = (await secondServer.handleToolCall('alembic_status', {})) as {
      data: {
        errorCode?: string;
        project?: { root: string; trust: string };
      };
      success: boolean;
    };

    expect(fs.existsSync(getSavedProjectRootPath())).toBe(false);
    expect(result.data.project?.root).not.toBe(projectRoot);
    if (!result.success) {
      expect(result.data.errorCode).toBe('CODEX_PROJECT_ROOT_REJECTED');
      expect(result.data.project?.trust).toBe('rejected');
    }
    expect(fs.existsSync(path.join(pluginRoot, '.asd'))).toBe(false);
  });

  test('status recommends bootstrap after initialization when knowledge is still empty', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_status', {})) as {
      success: boolean;
      data: {
        initialized: boolean;
        knowledge: { usable: boolean; recipeCount: number; skillCount: number };
        onboarding: { primaryAction: { tool: string }; state: string };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.initialized).toBe(true);
    expect(result.data.knowledge).toMatchObject({ usable: false, recipeCount: 0, skillCount: 0 });
    expect(result.data.onboarding).toMatchObject({
      state: 'needs_bootstrap',
      primaryAction: { tool: 'alembic_bootstrap' },
    });
  });

  test('status access runs daemon-less staging sweep and records lifecycle events', async () => {
    useTempAlembicHome();
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_MIN_INTERVAL_MS = '0';
    process.env.ALEMBIC_STAGING_ACCESS_SWEEP_TIMEOUT_MS = '0';
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    writePlanFixtureSource(projectRoot, 'stagingSweep');
    const server = new HostMcpServer({ projectRoot });

    const initStatus = (await server.handleToolCall('alembic_status', {})) as {
      data: { workspace?: { dataRoot?: string } };
      success: boolean;
    };
    expect(initStatus.success).toBe(true);
    const dataRoot = initStatus.data.workspace?.dataRoot ?? projectRoot;

    const now = Date.now();
    seedStagingRecipeRows(dataRoot, now);

    const result = (await server.handleToolCall('alembic_status', {})) as {
      success: boolean;
    };
    expect(result.success).toBe(true);

    await resetPluginOwnedMcpServerForTests();
    const rows = readStagingSweepRows(dataRoot);
    expect(rows.recipes).toEqual([
      expect.objectContaining({
        id: 'p1-due-auto',
        lifecycle: 'active',
        publishedBy: 'StagingManager',
        staging_deadline: null,
      }),
      expect.objectContaining({
        id: 'p1-due-manual',
        lifecycle: 'staging',
        staging_deadline: now - 1_000,
      }),
      expect.objectContaining({
        id: 'p1-future-auto',
        lifecycle: 'staging',
        staging_deadline: now + 60_000,
      }),
    ]);
    expect(rows.events).toEqual([
      {
        recipe_id: 'p1-due-auto',
        from_state: 'staging',
        to_state: 'active',
        trigger: 'grace-period-expire',
        operator_id: 'StagingManager',
      },
    ]);
  });

  test('explicit Codex init creates a Ghost workspace marker without starting daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_init', {})) as {
      success: boolean;
      data: {
        status: {
          autoInit: { markerExists: boolean; route: string };
          initialized: boolean;
          workspace: { dataRoot: string; ghost: boolean };
        };
      };
    };
    const marker = readInitMarker(projectRoot);

    expect(result.success).toBe(true);
    expect(result.data.status.initialized).toBe(true);
    expect(result.data.status.workspace.ghost).toBe(true);
    expect(result.data.status.autoInit).toMatchObject({
      markerExists: true,
      route: 'explicit',
    });
    expect(marker).toMatchObject({
      initializedBy: 'alembic_init',
      route: 'explicit',
      projectRoot,
    });
    expect(fs.existsSync(path.join(projectRoot, '.asd'))).toBe(false);
  });

  test('public init blocks ready when post-init status contradicts the written marker identity', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const server = new HostMcpServer({ projectRoot });
    vi.spyOn(server, 'buildStatus').mockResolvedValue({
      success: true,
      data: {
        initialized: false,
        knowledge: {
          initialized: false,
          usable: false,
        },
        project: {
          dataRootSource: 'project-root',
          projectId: 'contradictory-project',
          root: projectRoot,
        },
        workspace: {
          dataRootSource: 'project-root',
          ghost: false,
          mode: 'standard',
        },
      },
    });

    const rawResult = await server.handleToolCall('alembic_init', { standard: false });
    const publicResult = serializeMcpToolResult('alembic_init', rawResult, {
      isErrorResult: (value) =>
        !!value && typeof value === 'object' && (value as { success?: unknown }).success === false,
    }).structuredContent as Record<string, unknown>;

    expect(readInitMarker(projectRoot)).toMatchObject({
      ghost: true,
      initializedBy: 'alembic_init',
      projectRoot,
    });
    expect(publicResult).toMatchObject({
      ok: false,
      status: 'blocked',
      statusSnapshot: {
        initialized: false,
        project: {
          dataRootSource: 'project-root',
          projectId: 'contradictory-project',
          root: projectRoot,
        },
        workspace: {
          dataRootSource: 'project-root',
          ghost: false,
          mode: 'standard',
        },
      },
    });
    expect(publicResult.summary).toContain('post-initialization status');
  });

  test('explicit Codex init inherits an existing Standard registry mode', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, false);
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_init', {})) as {
      data: {
        mode: string;
        status: {
          initialized: boolean;
          project: { root: string };
          workspace: { ghost: boolean; mode: string };
        };
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.data.mode).toBe('standard');
    expect(result.data.status.project).toMatchObject({
      root: projectRoot,
    });
    expect(result.data.status.workspace).toMatchObject({
      ghost: false,
      mode: 'standard',
    });
    expect(ProjectRegistry.get(projectRoot)).toMatchObject({ id: entry.id, ghost: false });
    expect(fs.existsSync(path.join(projectRoot, '.asd', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(getGhostWorkspaceDir(entry.id), '.asd', 'config.json'))).toBe(
      false
    );
  });

  test('explicit Standard init fails closed on an existing Ghost registry mode', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_init', {
      standard: true,
    })) as {
      data: {
        errorCode: string;
        existingMode: string;
        needsUserInput: boolean;
        projectId: string;
        requestedMode: string;
      };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      errorCode: 'CODEX_WORKSPACE_MODE_CONFLICT',
      existingMode: 'ghost',
      needsUserInput: true,
      projectId: entry.id,
      requestedMode: 'standard',
    });
    expect(ProjectRegistry.get(projectRoot)).toMatchObject({ id: entry.id, ghost: true });
    expect(fs.existsSync(path.join(projectRoot, '.asd'))).toBe(false);
  });

  test('removed AI config tool is not exposed as a Plugin configuration surface', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const server = new HostMcpServer({ projectRoot });

    const removedToolName = ['alembic', 'codex', 'ai', 'config'].join('_');
    const result = (await server.handleToolCall(removedToolName, {
      mode: 'status',
    })) as {
      data: { errorCode: string };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data.errorCode).toBe('CODEX_UNKNOWN_TOOL');
    expect(readInitMarker(projectRoot)).toBeNull();
  });

  test('init-on-demand initializes before reading Codex job status', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_job', { limit: 5 })) as {
      success: boolean;
      data: { jobs: unknown[] };
    };
    const marker = readInitMarker(projectRoot);

    expect(result.success).toBe(true);
    expect(result.data.jobs).toEqual([]);
    expect(marker).toMatchObject({
      initializedBy: 'codex-plugin-init-on-demand',
      requestedTool: 'alembic_job',
      route: 'tool-call',
    });
    expect(fs.existsSync(path.join(projectRoot, '.asd'))).toBe(false);
  });

  test('tool-call projectRoot override sends init to the requested project', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'gxfn',
      'alembic',
      getPackageVersion()
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;

    const projectRoot = makeProjectRoot();
    const server = new HostMcpServer();

    const result = (await server.handleToolCall('alembic_init', { projectRoot })) as {
      data: { status: { initialized: boolean; workspace: { ghost: boolean } } };
      success: boolean;
    };
    const marker = readInitMarker(projectRoot);

    expect(result.success).toBe(true);
    expect(result.data.status.workspace.ghost).toBe(true);
    expect(marker).toMatchObject({
      initializedBy: 'alembic_init',
      projectRoot,
      route: 'explicit',
    });
    expect(readSavedProjectRoot()).toMatchObject({ projectRoot });
    expect(fs.existsSync(path.join(pluginRoot, '.asd'))).toBe(false);
  });

  test('status and diagnostics do not initialize a fresh workspace', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const server = new HostMcpServer({ projectRoot });

    await server.handleToolCall('alembic_status', {});
    await server.handleToolCall('alembic_status', { aspect: 'runtime' });

    expect(readInitMarker(projectRoot)).toBeNull();
    expect(fs.existsSync(path.join(projectRoot, '.asd'))).toBe(false);
  });

  test('manual init fails closed when only a plugin-cache fallback root is available', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    delete process.env.INIT_CWD;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'gxfn',
      'alembic',
      getPackageVersion()
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;
    const server = new HostMcpServer();

    const result = (await server.handleToolCall('alembic_init', {})) as {
      data: {
        errorCode: string;
        needsUserInput: boolean;
        projectRootResolution: { trust: string; userMessage: string };
        required: { projectRoot: string };
        requiredActions: string[];
      };
      message: string;
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.message).toContain('cannot determine the target project directory');
    expect(result.data.errorCode).toBe('CODEX_PROJECT_ROOT_REJECTED');
    expect(result.data.needsUserInput).toBe(true);
    expect(result.data.required.projectRoot).toBe('absolute path');
    expect(result.data.requiredActions).toContain(
      'Provide the target project root as an absolute path.'
    );
    expect(result.data.projectRootResolution.trust).toBe('rejected');
    expect(result.data.projectRootResolution.userMessage).toContain(
      'project workflows cannot be used yet'
    );
    expect(fs.existsSync(path.join(pluginRoot, '.asd'))).toBe(false);
  });

  test('unresolved Desktop project root exposes tools that require explicit projectRoot', async () => {
    useTempAlembicHome();
    delete process.env.ALEMBIC_PROJECT_DIR;
    delete process.env.CODEX_WORKSPACE_DIR;
    delete process.env.CODEX_WORKSPACE_ROOT;
    delete process.env.INIT_CWD;
    const pluginRoot = path.join(
      makeProjectRoot(),
      '.codex',
      'plugins',
      'cache',
      'gxfn',
      'alembic',
      getPackageVersion()
    );
    fs.mkdirSync(pluginRoot, { recursive: true });
    process.env.PWD = pluginRoot;

    const tools = getVisibleTools('agent');
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const server = new HostMcpServer();

    // MTC-4: alembic_status is now a cold-start discovery tool (exempt from the
    // project-root requirement), so it no longer rejects an unresolved root. Use a
    // non-discovery cold-start tool (alembic_init) to exercise the root gate.
    const result = (await server.handleToolCall('alembic_init', {})) as {
      data: { errorCode: string; needsUserInput: boolean; required: { projectRoot: string } };
      success: boolean;
    };

    expect(byName.has('alembic_task')).toBe(false);
    expect(byName.get('alembic_code_guard')?.inputSchema?.properties).toMatchObject({
      projectRoot: {
        type: 'string',
      },
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      errorCode: 'CODEX_PROJECT_ROOT_REJECTED',
      needsUserInput: true,
      required: { projectRoot: 'absolute path' },
    });
  });

  test('diagnostics reports runtime version and artifact guidance without starting daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_status', { aspect: 'runtime' })) as {
      success: boolean;
      data: {
        cleanup: { automaticOnUninstall: boolean; command: string };
        checks: {
          packagePin: boolean;
          pluginAssets: boolean;
          pluginMcpEntry: boolean;
          pluginSkills: boolean;
        };
        nextActions: string[];
        offlineFallback: { localPackage: string; registryPackageFallback: boolean };
        package: { pinnedSpecifier: string; version: string };
        plugin: {
          mcp: {
            entry: {
              mode: string;
              runtimeTarball: { exists: boolean };
              staleReasons: string[];
            };
            ok: boolean;
            packagePin: boolean;
            wrapper: {
              startupLockDiagnostics: {
                cacheParentCreation: boolean;
                releaseSignals: string[];
                runtimeTarballPreflight: boolean;
                scope: string;
                waitDiagnostics: boolean;
              };
            };
          };
          skills: { ok: boolean };
        };
        projectRuntime: {
          entryMode: { mode: string };
          fallbackIsolation: Array<{ effectiveIdentityAllowed: boolean; id: string }>;
          requiredServices: Array<{ service: string; source: string }>;
          sourcePolicy: { selectedOrActiveCanOverrideEffectiveIdentity: boolean };
        };
        primaryAction: { tool: string };
        summary: string;
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.package.pinnedSpecifier).toBe(`alembic-runtime@${getPackageVersion()}`);
    expect(result.data.checks).toMatchObject({
      packagePin: true,
      pluginAssets: true,
      pluginMcpEntry: true,
      pluginSkills: true,
    });
    expect(result.data.plugin.mcp).toMatchObject({ ok: true, packagePin: true });
    expect(result.data.plugin.mcp.entry).toMatchObject({
      mode: 'marketplace-shell',
      staleReasons: [],
    });
    expect(result.data.plugin.mcp.wrapper.path).toContain('alembic-start.mjs');
    expect(result.data.plugin.skills.ok).toBe(true);
    expect(result.data.nextActions).toContain('Alembic Codex runtime checks passed.');
    expect(result.data.primaryAction.tool).toBe('alembic_status');
    expect(result.data.summary).toContain('runtime checks passed');
    expect(result.data.offlineFallback).toMatchObject({
      localPackage: `alembic-runtime@${getPackageVersion()}`,
      registryPackageFallback: false,
    });
    expect(result.data.cleanup).toMatchObject({
      automaticOnUninstall: false,
      command: 'alembic_runtime',
    });
    expect(result.data.projectRuntime).toMatchObject({
      entryMode: { mode: 'marketplace-shell' },
      sourcePolicy: {
        selectedOrActiveCanOverrideEffectiveIdentity: false,
      },
    });
    expect(result.data.projectRuntime.fallbackIsolation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effectiveIdentityAllowed: false,
          id: 'embedded-plugin-owned-runtime',
        }),
      ])
    );
    expect(result.data.projectRuntime.requiredServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ service: 'project-identity', source: 'codex-current-project' }),
      ])
    );
  });

  test('diagnostics reports explicit admin opt-in guidance when admin tier is requested', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    process.env.ALEMBIC_MCP_TIER = 'admin';
    delete process.env.ALEMBIC_CODEX_ENABLE_ADMIN;
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_status', { aspect: 'runtime' })) as {
      success: boolean;
      data: {
        checks: { adminGate: boolean };
        issues: Array<{ code: string }>;
        nextActions: string[];
        ok: boolean;
        primaryAction: { tool: string };
        summary: string;
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.ok).toBe(false);
    expect(result.data.checks.adminGate).toBe(false);
    expect(result.data.issues.map((issue) => issue.code)).toContain('CODEX_ADMIN_OPT_IN_REQUIRED');
    expect(result.data.primaryAction.tool).toBe('alembic_status');
    expect(result.data.summary).toContain('warning');
    expect(result.data.nextActions).toContain(
      'Set ALEMBIC_CODEX_ENABLE_ADMIN=1 only for explicit admin workflows.'
    );
  });

  // MTC-4: removed 'core Alembic tools stay Plugin-owned and do not call the removed
  // daemon MCP bridge' — it asserted alembic_health's callPluginOwnedTool execution
  // wrapper (serviceBoundary / projectRuntime.identity / codexProjectScopeExecution),
  // which the merged alembic_status (cold-start local buildStatus) does not reproduce.
  // serviceBoundary is still covered by CodexServiceRequestBoundary.test; the
  // no-daemon-MCP-bridge property by the resident-tool and host-agent-bootstrap tests.

  test('alembic_task prime direct call is retired before daemon bridge execution', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('alembic_task prime must not call the daemon MCP bridge');
    });
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_task', {
      operation: 'prime',
      userQuery: 'Use Alembic knowledge before editing',
      language: 'typescript',
    })) as {
      error: { code: string };
      ok: boolean;
      status: string;
    };

    expect(result.ok).toBe(false);
    expect(result.status).toBe('retired');
    expect(result.error.code).toBe('CODEX_TOOL_RETIRED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('blocks public read tools before initialization', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_graph', {})) as {
      data: { errorCode?: string };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data.errorCode).toBe('CODEX_ALEMBIC_KNOWLEDGE_REQUIRED');
  });

  test('allows public graph reads after initialization even before Recipes exist', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    writePlanFixtureSource(projectRoot, 'initializedEmptyGraph');
    const server = new HostMcpServer({ projectRoot });
    const databasePath = path.join(projectRoot, '.asd', 'alembic.db');
    const beforeDatabase = captureDatabaseFamily(databasePath);
    const beforeInputs = captureReadOnlySearchInputs(projectRoot);

    const result = (await server.handleToolCall('alembic_graph', {
      queryKind: 'space',
    })) as {
      structuredContent?: {
        diagnostics?: Array<{ code?: string }>;
        ok?: boolean;
        project?: { projectRoot?: string };
        refs?: unknown[];
        status?: string;
      };
    };

    expect(result.structuredContent?.project?.projectRoot).toBe(projectRoot);
    expect(result.structuredContent?.diagnostics?.map((item) => item.code)).not.toContain(
      'alembic-graph-output-contract-mismatch'
    );
    expect(result.structuredContent?.ok).toBe(true);
    expect(result.structuredContent?.refs?.length).toBeGreaterThan(0);
    expect(captureDatabaseFamily(databasePath)).toEqual(beforeDatabase);
    expect(captureReadOnlySearchInputs(projectRoot)).toEqual(beforeInputs);
  });

  test('blocks retired task close before Plugin evidence/evolution execution', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    makeDirtyGitRepo(projectRoot);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`alembic_task close must stay Plugin-owned: ${String(input)}`);
    });
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_task', {
      operation: 'close',
      id: 'acceptance-smoke',
      reason: 'dirty diff acceptance smoke',
      changedFiles: ['index.ts'],
    })) as {
      error: { code: string };
      ok: boolean;
      status: string;
    };

    expect(result.ok).toBe(false);
    expect(result.status).toBe('retired');
    expect(result.error.code).toBe('CODEX_TOOL_RETIRED');
    expect(JSON.stringify(result)).not.toContain('guardDecision');
    expect(JSON.stringify(result)).not.toContain('opportunisticEvolution');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('blocks retired task close with unrelated dirty diff before Guard/evolution checks', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    makeDirtyGitRepo(projectRoot);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`alembic_task close must stay Plugin-owned: ${String(input)}`);
    });
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_task', {
      operation: 'close',
      id: 'acceptance-smoke',
      reason: 'close without task-scoped files',
    })) as {
      error: { code: string };
      ok: boolean;
      status: string;
    };

    expect(result.ok).toBe(false);
    expect(result.status).toBe('retired');
    expect(result.error.code).toBe('CODEX_TOOL_RETIRED');
    expect(JSON.stringify(result)).not.toContain('guardDecision');
    expect(JSON.stringify(result)).not.toContain('opportunisticEvolution');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('Codex bootstrap job runs in-process via local JobStore without the daemon', async () => {
    // PDR-2a: alembic_job bootstrap runs synchronously in-process and persists to a
    // local JobStore; the daemon is never spawned or contacted over HTTP.
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`alembic_job bootstrap must not call the daemon HTTP API: ${String(input)}`);
    });
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_job', {
      op: 'bootstrap',
      maxFiles: 25,
    })) as { success: boolean; data?: { job?: { id?: string; status?: string } } };

    // PDR-2a routing invariant: the job ran in-process — the daemon was neither
    // spawned nor contacted over HTTP. (The bootstrap workflow's full outcome needs a
    // complete runtime and is validated at Test/PDR-6; in this unit env it may degrade.)
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(typeof result.success).toBe('boolean');
    // The job was created + persisted to the local JobStore by the in-process path.
    const persisted = new JobStore({ projectRoot }).list({ kind: 'bootstrap' });
    expect(persisted.length).toBeGreaterThan(0);
  });

  test('Codex host-agent bootstrap runs in the Plugin without the daemon MCP bridge', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    writePlanFixtureSource(projectRoot, 'answer');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(
        `Codex host-agent bootstrap must not call daemon MCP bridge: ${String(input)}`
      );
    });
    const server = new HostMcpServer({ projectRoot });
    const { planSelection } = await confirmPlanForHostBootstrap(server, projectRoot);

    const result = (await server.handleToolCall('alembic_bootstrap', { planSelection })) as {
      data?: {
        bootstrapState?: {
          runtime?: { daemonRequiredForBootstrap?: boolean; owner?: string };
          singleWriterLease?: { publicStatus?: string; status?: string };
          projectContext?: { firstTool?: string };
          status?: string;
        };
        currentDimensionGuidance?: {
          currentTier?: { dimensions?: string[]; tier?: number };
          completionRule?: {
            requiredClosingTool?: string;
          };
          dimensionIds?: string[];
          dimensions?: Array<{
            analysisGuide?: unknown;
            dimensionId?: string;
            submissionSpec?: unknown;
          }>;
          remainingDimensionIds?: string[];
        };
        currentDimensionNextActions?: Array<{ required?: boolean; tool?: string }>;
        currentDomainSop?: unknown;
        domainQueue?: unknown;
        dimensions?: unknown;
        executionPlan?: unknown;
        gates?: Record<string, unknown>;
        hostAgentContract?: {
          dimensionCompletionContract?: {
            firstCallExample?: Record<string, unknown>;
            completionGate?: boolean;
            requiredFields?: string[];
            sessionField?: string;
          };
          knowledgeResetContract?: { backupByDefault?: boolean; scopes?: string[] };
          recipeCreationSop?: string[];
          recipeAuthoringRubric?: Record<string, unknown>;
          resumePrompt?: Record<string, unknown>;
          scopeBrief?: Record<string, unknown>;
          stopConditions?: string[];
          submitKnowledgeContract?: {
            exactFields?: string[];
            fieldFloors?: Record<string, unknown>;
            purpose?: string;
            sourceRefCardinality?: Record<string, unknown>;
          };
          toolCapabilityMatrix?: Array<{ name?: string }>;
        };
        sopPack?: unknown;
        serviceBoundary?: {
          executionPath: string;
          owner: string;
          tool: string;
        };
        toolCapabilities?: {
          canonicalProjectContext?: Array<{ name?: string }>;
          removedOrBlocked?: Array<{ name?: string; replacementTools?: string[] }>;
        };
      };
      meta?: {
        fullBriefingRef?: { bytes?: number; path?: string } | null;
      };
      success: boolean;
    };

    expect(result.success).toBe(true);
    const mcpResult = serializeMcpToolResult('alembic_bootstrap', result, {
      isErrorResult: (value) =>
        !!value && typeof value === 'object' && (value as { success?: unknown }).success === false,
    });
    const structured = mcpResult.structuredContent as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(structured), 'utf8')).toBeLessThanOrEqual(20 * 1024);
    expect(readRecord(structured.meta).fullBriefingRef).toMatchObject({
      bytes: expect.any(Number),
      path: expect.any(String),
    });
    expect(result.meta?.fullBriefingRef).toMatchObject({
      bytes: expect.any(Number),
      path: expect.any(String),
    });
    const fullBriefingPath = result.meta?.fullBriefingRef?.path;
    expect(fullBriefingPath ? fs.existsSync(fullBriefingPath) : false).toBe(true);
    const fullBriefingRaw = fs.readFileSync(fullBriefingPath || '', 'utf8');
    const fullBriefing = JSON.parse(fullBriefingRaw) as {
      dimensions?: unknown[];
      hostAgentContract?: { recipeAuthoringFrontLoad?: Record<string, unknown> };
    };
    expect(readArray(fullBriefing.dimensions).length).toBe(
      readArray(result.data?.dimensions).length
    );
    expect(Buffer.byteLength(JSON.stringify(fullBriefing.dimensions), 'utf8')).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(result.data?.dimensions), 'utf8')
    );
    // P2.3 / 13.L / P2.4：超预算时完整 briefing（fullBriefingRef）必须携带从 @alembic/core/knowledge
    // 渲染的 Recipe 创作前置契约——worked example 不被剥离、doClause 允许动词字面量、scope 证据逃逸、
    // 失败模式目录、buildPreSubmitChecklist 清单都在场（guidance==gate）。
    const frontLoad = fullBriefing.hostAgentContract?.recipeAuthoringFrontLoad as
      | {
          workedExample?: { candidate?: { content?: { markdown?: string } } };
          guidanceText?: string;
          imperativeVerbs?: { positive?: string[] };
          failureModeCatalog?: Array<{ code?: string }>;
          preSubmitChecklist?: string[];
        }
      | undefined;
    expect(frontLoad).toBeTruthy();
    // (a) worked example object present and NOT stripped
    expect(frontLoad?.workedExample?.candidate?.content?.markdown).toContain('✅');
    expect(frontLoad?.workedExample?.candidate?.content?.markdown).toContain('❌');
    // (b) literal allowlisted verbs in the doClause guidance
    expect(frontLoad?.imperativeVerbs?.positive).toEqual(
      expect.arrayContaining(['use', 'validate', 'prefer'])
    );
    expect(frontLoad?.guidanceText).toContain('use, validate');
    // (c) the scope: narrow (file-local) evidence-floor escape text
    expect(frontLoad?.guidanceText).toContain('scope: narrow');
    // P2.4：失败模式目录与 pre-submit 清单单源自规范模块（FAIL_EXAMPLES/checklist 不再压缩丢失）。
    expect((frontLoad?.failureModeCatalog || []).length).toBeGreaterThan(0);
    expect((frontLoad?.preSubmitChecklist || []).length).toBeGreaterThan(0);
    expect(result.data?.executionPlan).toBeTruthy();
    expect(result.data?.dimensions).toBeTruthy();
    expect(result.data?.serviceBoundary).toMatchObject({
      executionPath: 'plugin-owned-codex-facing',
      owner: 'alembic-plugin',
      tool: 'alembic_bootstrap',
    });
    expect(result.data?.bootstrapState).toMatchObject({
      runtime: {
        daemonRequiredForBootstrap: false,
        owner: 'alembic-plugin',
      },
      projectContext: {
        firstTool: 'alembic_recipe_map',
      },
      singleWriterLease: {
        publicStatus: 'no_active_bootstrap',
        status: 'available',
      },
      status: 'bootstrap_ready',
    });
    const executionPlan = result.data?.executionPlan as
      | { tiers?: Array<{ dimensions?: string[] }> }
      | undefined;
    const currentTierDimensionIds = executionPlan?.tiers?.[0]?.dimensions || [];
    expect(currentTierDimensionIds.length).toBeGreaterThan(0);
    expect(result.data?.currentDimensionGuidance?.currentTier?.dimensions).toEqual(
      currentTierDimensionIds
    );
    expect(result.data?.currentDimensionGuidance?.dimensionIds).toEqual(currentTierDimensionIds);
    expect(result.data?.currentDimensionGuidance?.remainingDimensionIds).toEqual(
      currentTierDimensionIds
    );
    expect(result.data?.currentDimensionGuidance?.completionRule).toMatchObject({
      requiredClosingTool: 'alembic_dimension_complete',
    });
    expect(
      result.data?.currentDimensionGuidance?.dimensions?.map((dimension) => dimension.dimensionId)
    ).toEqual(currentTierDimensionIds);
    const inlineFullDimensions = (result.data?.currentDimensionGuidance?.dimensions || []).filter(
      (dimension) => dimension.analysisGuide && dimension.submissionSpec
    );
    expect(inlineFullDimensions.length).toBeGreaterThan(0);
    for (const dimension of inlineFullDimensions) {
      expect(dimension.analysisGuide).toBeTruthy();
      expect(dimension.submissionSpec).toBeTruthy();
      const submissionSpec = dimension.submissionSpec as {
        preSubmitChecklist?: { rejectIf?: string[]; required?: string[] };
      };
      expect(submissionSpec.preSubmitChecklist?.required).toEqual(
        expect.arrayContaining([expect.stringContaining('P5: EN do/dont + ✅/❌')])
      );
    }
    expect(result.data?.currentDimensionGuidance?.dimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          completenessCritic: expect.objectContaining({
            shouldBlockCompletion: false,
            targetGate: 'advisory',
          }),
        }),
      ])
    );
    expect(result.data?.currentDimensionNextActions?.map((action) => action.tool)).toEqual(
      expect.arrayContaining(['alembic_recipe_map', 'alembic_graph'])
    );
    expect(result.data?.currentDimensionNextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: true, tool: 'alembic_submit_knowledge' }),
        expect.objectContaining({ required: true, tool: 'alembic_dimension_complete' }),
      ])
    );
    expect(result.data?.hostAgentContract?.dimensionCompletionContract).toMatchObject({
      completionGate: true,
    });
    expect(result.data?.currentDomainSop).toBeUndefined();
    expect(result.data?.domainQueue).toBeUndefined();
    expect(result.data?.sopPack).toBeUndefined();
    expect(
      result.data?.toolCapabilities?.canonicalProjectContext?.map((entry) => entry.name)
    ).toEqual(expect.arrayContaining(['alembic_recipe_map', 'alembic_graph']));
    const removedOrBlocked = result.data?.toolCapabilities?.removedOrBlocked?.map(
      (entry) => entry.name
    );
    if (removedOrBlocked) {
      expect(removedOrBlocked).toEqual(expect.arrayContaining(['alembic_call_context']));
      expect(removedOrBlocked).not.toContain('alembic_panorama');
    }
    const bootstrapPayload = JSON.stringify(result.data);
    expect(bootstrapPayload).not.toContain('D1-runtime-entrypoints');
    expect(bootstrapPayload).not.toContain('D2-source-structure-ownership');
    expect(bootstrapPayload).not.toContain('D3-state-persistence');
    expect(bootstrapPayload).not.toContain('D4-tool-contracts-output');
    expect(bootstrapPayload).not.toContain('D5-validation-safety');
    expect(bootstrapPayload).not.toContain('D6-failure-recovery');
    expect(bootstrapPayload).not.toContain('D7-project-conventions');
    expect(bootstrapPayload).not.toContain('runtime-entrypoints');
    expect(bootstrapPayload).not.toContain('tool-contracts');
    expect(bootstrapPayload).not.toContain('domainRefs');
    expect(JSON.stringify(result.data?.hostAgentContract)).not.toContain('alembic_call_context');
    expect(JSON.stringify(result.data?.hostAgentContract)).not.toContain('alembic_affected_tests');
    expect(result.data?.hostAgentContract).toMatchObject({
      scopeBrief: expect.any(Object),
      recipeCreationSop: expect.arrayContaining([
        'Check ProjectContext matrix/graph orientation first.',
      ]),
      recipeAuthoringRubric: expect.objectContaining({
        futureActionability: expect.any(String),
      }),
      knowledgeResetContract: expect.objectContaining({
        backupByDefault: true,
        scopes: expect.arrayContaining(['host-agent bootstrap session state']),
      }),
      dimensionCompletionContract: expect.objectContaining({
        sessionField: expect.stringContaining('sessionId'),
        requiredFields: expect.arrayContaining([
          'sessionId',
          'dimensionId',
          'submittedRecipeIds',
          'referencedFiles',
          'keyFindings',
          'analysisText',
          'candidateCount',
        ]),
        firstCallExample: expect.objectContaining({
          sessionId: 'bootstrapState.session.id',
        }),
      }),
      resumePrompt: expect.objectContaining({
        bootstrapSessionRefField: 'bootstrapState.session.id',
      }),
      stopConditions: expect.arrayContaining(['another bootstrap writer holds the lease']),
      submitKnowledgeContract: expect.objectContaining({
        exactFields: expect.arrayContaining([
          'content.markdown',
          'reasoning.whyStandard',
          'reasoning.confidence',
          'usageGuide',
        ]),
        fieldFloors: expect.objectContaining({
          category: expect.stringContaining('View/Service/Tool'),
          contentMarkdown: expect.stringContaining('✅ correct / ❌ forbidden contrast'),
          doClause: expect.stringContaining('English imperative'),
          dontClause: expect.stringContaining('English negative imperative'),
        }),
        purpose: expect.stringContaining('before the first submit call'),
        sourceRefCardinality: expect.objectContaining({
          universalRuleOrPattern: expect.stringContaining('>=3'),
        }),
      }),
    });
    expect(result.data?.hostAgentContract?.recipeGuidanceFloor).toMatchObject({
      candidateCounts: expect.objectContaining({
        minimumPerDimension: 3,
        targetPerDimension: 5,
      }),
    });
    expect(result.data?.hostAgentContract?.toolCapabilityMatrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'alembic_recipe_map',
        }),
      ])
    );
    expect(result.data?.gates).toHaveProperty('runtimeTransport');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('projectRoot override can switch Plugin-owned bootstrap between projects', async () => {
    useTempAlembicHome();
    const firstProjectRoot = makeProjectRoot();
    const secondProjectRoot = makeProjectRoot();
    makeInitializedWorkspace(firstProjectRoot);
    makeInitializedWorkspace(secondProjectRoot);
    writePlanFixtureSource(firstProjectRoot, 'first');
    writePlanFixtureSource(secondProjectRoot, 'second');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(
        `Codex host-agent bootstrap must not call daemon MCP bridge: ${String(input)}`
      );
    });
    const server = new HostMcpServer();
    const firstPlan = await confirmPlanForHostBootstrap(server, firstProjectRoot);
    const secondPlan = await confirmPlanForHostBootstrap(server, secondProjectRoot);

    const first = (await server.handleToolCall('alembic_bootstrap', {
      planSelection: firstPlan.planSelection,
      projectRoot: firstProjectRoot,
    })) as { message?: string; success: boolean };
    const second = (await server.handleToolCall('alembic_bootstrap', {
      planSelection: secondPlan.planSelection,
      projectRoot: secondProjectRoot,
    })) as { message?: string; success: boolean };

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.message || '').not.toContain('不允许在同一进程中切换项目');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('blocks direct admin tool calls without Codex admin opt-in', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    process.env.ALEMBIC_MCP_TIER = 'admin';
    delete process.env.ALEMBIC_CODEX_ENABLE_ADMIN;
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_knowledge_lifecycle', {
      operation: 'approve',
    })) as {
      data: { errorCode: string; needsUserInput: boolean };
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      errorCode: 'CODEX_ADMIN_OPT_IN_REQUIRED',
      needsUserInput: true,
    });
  });

  test('Codex job status reads local JobStore without starting daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const store = new JobStore({ projectRoot });
    const job = store.create({ kind: 'rescan', request: { reason: 'codex' }, source: 'codex' });
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_job', { jobId: job.id })) as {
      success: boolean;
      data: {
        job: { id: string };
        jobRoute: {
          fallback: boolean;
          fallbackIsolation: { effectiveIdentityAllowed: boolean; id: string };
          selected: string;
        };
        projectRuntime: { blockedFallbacks: string[]; fallbackIsolation: Array<{ id: string }> };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.job.id).toBe(job.id);
    expect(result.data.jobRoute).toMatchObject({
      fallback: true,
      fallbackIsolation: {
        effectiveIdentityAllowed: false,
        id: 'local-jobstore',
      },
      selected: 'embedded-host-agent-recoverable',
    });
    expect(result.data.projectRuntime.blockedFallbacks).toContain(
      'local-jobstore-default-effective-identity'
    );
  });

  // PDR-3 retired the embedded plugin daemon and its resident job HTTP client:
  // HostMcpServer.tryReadJobFromDaemon() now always returns null and readJob()
  // reads the local JobStore in-process. The former "uses resident service
  // client / fetches http://127.0.0.1:39127/api/v1/jobs/..." test asserted a
  // path that no longer exists; local-only read is covered by "Codex job status
  // reads local JobStore without starting daemon" and the fallback case below.

  test('Codex job status falls back to local JobStore when daemon job API is unavailable', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    const store = new JobStore({ projectRoot });
    const job = store.create({ kind: 'bootstrap', request: { maxFiles: 25 }, source: 'codex' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection closed'));
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_job', { jobId: job.id })) as {
      success: boolean;
      data: {
        job: { id: string };
        jobRoute: {
          fallback: boolean;
          fallbackIsolation: { allowedUse: string; effectiveIdentityAllowed: boolean; id: string };
          reason: string;
          selected: string;
        };
        projectRuntime: { blockedFallbacks: string[]; fallbackIsolation: Array<{ id: string }> };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.job.id).toBe(job.id);
    expect(result.data.jobRoute).toMatchObject({
      fallback: true,
      fallbackIsolation: {
        allowedUse: 'embedded-host-agent-recovery',
        effectiveIdentityAllowed: false,
        id: 'local-jobstore',
      },
      reason: 'resident-job-api-unavailable-or-not-ready',
      selected: 'embedded-host-agent-recoverable',
    });
    expect(result.data.projectRuntime.blockedFallbacks).toContain(
      'local-jobstore-default-effective-identity'
    );
  });

  test('cleanup defaults to dry-run and does not stop daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeUsableKnowledgeBase(projectRoot);
    const server = new HostMcpServer({ projectRoot });

    const result = (await server.handleToolCall('alembic_runtime', { action: 'cleanup' })) as {
      success: boolean;
      data: {
        dryRun: boolean;
        projectRuntime: {
          identity: { projectRoot: string; runtimeDir: string };
          requiredServices: Array<{ required: boolean; service: string }>;
        };
        targets: { runtimeDir: string; statePath: string };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.dryRun).toBe(true);
    expect(result.data.targets.runtimeDir).toContain('.asd');
    expect(result.data.targets.statePath).toBe(
      path.join(result.data.projectRuntime.identity.runtimeDir, 'daemon.json')
    );
    expect(result.data.projectRuntime.identity.projectRoot).toBe(projectRoot);
    expect(result.data.projectRuntime.requiredServices).toEqual(
      expect.arrayContaining([expect.objectContaining({ required: true, service: 'daemon' })])
    );
  });

  test('package and plugin config point Codex to the packaged MCP runtime tarball', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      version: string;
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    const pluginMcp = JSON.parse(
      fs.readFileSync(path.resolve('plugins/alembic-codex/.mcp.json'), 'utf8')
    ) as {
      mcpServers: {
        alembic: { args: string[]; command: string; cwd: string; env: Record<string, string> };
      };
    };
    const pluginJson = JSON.parse(
      fs.readFileSync(path.resolve('plugins/alembic-codex/.codex-plugin/plugin.json'), 'utf8')
    ) as { interface: { defaultPrompt: string[]; screenshots: string[] } };

    expect(packageJson.bin['alembic-codex-mcp']).toBe('dist/bin/host-mcp.js');
    expect(packageJson.scripts['dev:codex-plugin:reload']).toBe(
      'node scripts/dev-reload-codex-plugin.mjs'
    );
    expect(packageJson.scripts['dev:codex-plugin:refresh']).toBe(
      'node scripts/dev-reload-codex-plugin.mjs --legacy-refresh'
    );
    expect(packageJson.scripts['verify:codex-plugin']).toBe('node scripts/verify-codex-plugin.mjs');
    expect(pluginMcp.mcpServers.alembic.command).toBe('node');
    expect(pluginMcp.mcpServers.alembic.args).toContain('./bin/alembic-start.mjs');
    expect(
      fs
        .readFileSync(path.resolve('plugins/alembic-codex/bin/alembic-start.mjs'), 'utf8')
        .includes(`alembic-runtime@${getPackageVersion()}`)
    ).toBe(true);
    expect(pluginMcp.mcpServers.alembic.cwd).toBe('.');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_RUNTIME_MODE).toBe('plugin');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_PLUGIN_HOST).toBe('codex');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_MCP_MODE).toBe('1');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_CODEX_MCP_MODE).toBe('1');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_CODEX_PLUGIN_ROOT).toBe('.');
    expect(pluginMcp.mcpServers.alembic.env.ALEMBIC_CODEX_ENABLE_ADMIN).toBe('0');
    expect(pluginMcp.mcpServers.alembic.env.npm_config_cache).toBeUndefined();
    expect(pluginJson.interface.defaultPrompt).toContain(
      'Guide me through Alembic Codex first-minute setup for this project'
    );
    expect(pluginJson.interface.defaultPrompt).toContain(
      'Initialize Alembic Codex in Ghost mode for this project'
    );
    expect(pluginJson.interface.defaultPrompt).toContain(
      'Run Alembic Codex diagnostics for this project'
    );
    expect(pluginJson.interface.screenshots).toContain('./assets/alembic-codex-status.svg');
    expect(fs.existsSync(path.resolve('plugins/alembic-codex/skills/alembic/SKILL.md'))).toBe(true);
  });
});
