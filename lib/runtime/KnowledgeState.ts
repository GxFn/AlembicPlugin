import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonJobKind, DaemonJobRecord, DaemonJobStatus } from '@alembic/core/daemon';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { readSnapshotState, readSourceRefState } from '#infra/database/SqliteDatabaseAccess.js';
import {
  countProjectDatabaseRecipes,
  countProjectSkillKnowledgeEntries,
} from '../repository/skills/ProjectSkillKnowledgeRepository.js';

export type KnowledgeStatus =
  | 'not_initialized'
  | 'initialized_empty'
  | 'bootstrap_running'
  | 'knowledge_ready'
  | 'knowledge_stale';

export type KnowledgeFreshnessStatus =
  | 'current'
  | 'refresh_failed'
  | 'refresh_running'
  | 'source_refs_stale'
  | 'unknown';

export type VectorStatus = 'empty' | 'missing' | 'ready' | 'unreadable';

export interface JobSummary {
  channelId?: string;
  client?: string;
  completedAt?: string;
  createdAt?: string;
  createdByTool?: string;
  id: string;
  kind: DaemonJobKind;
  request?: {
    contentMaxLines?: number;
    dimensions?: string[];
    maxFiles?: number;
    reason?: string;
    skipGuard?: boolean;
  };
  sessionId?: string;
  source?: string;
  status: DaemonJobStatus;
  updatedAt?: string;
}

export interface JobActivityState {
  active: JobSummary[];
  bootstrapRunning: boolean;
  jobsDir: string;
  jobsDirExists: boolean;
  latest: JobSummary | null;
  latestTerminal: JobSummary | null;
  rescanRunning: boolean;
  running: boolean;
  total: number;
}

export interface KnowledgeFreshness {
  checkedAt: string;
  latestJobAt: string | null;
  latestKnowledgeAt: string | null;
  reason: string | null;
  stale: boolean;
  status: KnowledgeFreshnessStatus;
}

export interface VectorState {
  documentCount: number | null;
  hnswIndexPath: string;
  indexDir: string;
  jsonIndexPath: string;
  memoryEmbeddingsPath: string;
  nonBlocking: boolean;
  ready: boolean;
  reason: string | null;
  skipped: boolean;
  status: VectorStatus;
  updatedAt: string | null;
}

export interface SourceRefState {
  activeCount: number;
  databasePath: string;
  reason: string | null;
  renamedCount: number;
  staleCount: number;
  staleRecipeCount: number;
  status: 'missing' | 'ready' | 'stale' | 'unavailable';
  tableExists: boolean;
  totalCount: number;
}

export interface SnapshotState {
  databasePath: string;
  latest: {
    affectedDimsCount: number;
    candidateCount: number;
    changedFilesCount: number;
    createdAt: string;
    dimensionCount: number;
    fileCount: number;
    id: string;
    isIncremental: boolean;
    primaryLang: string | null;
    sessionId: string | null;
  } | null;
  reason: string | null;
  status: 'missing' | 'ready' | 'unavailable';
  tableExists: boolean;
  totalCount: number;
}

export interface HostKnowledgeState {
  databaseEntryCount?: number;
  dbRecipeCount?: number;
  freshness?: KnowledgeFreshness;
  hasKnowledge: boolean;
  initialized: boolean;
  jobs?: JobActivityState;
  materializedRecipeCount?: number;
  recipeCount: number;
  skillCount: number;
  status: KnowledgeStatus;
  sourceRefs?: SourceRefState;
  snapshots?: SnapshotState;
  usable: boolean;
  vector?: VectorState;
}

export const EMPTY_KNOWLEDGE_STATE: HostKnowledgeState = {
  freshness: {
    checkedAt: new Date(0).toISOString(),
    latestJobAt: null,
    latestKnowledgeAt: null,
    reason: 'workspace has not been inspected',
    stale: false,
    status: 'unknown',
  },
  hasKnowledge: false,
  initialized: false,
  jobs: {
    active: [],
    bootstrapRunning: false,
    jobsDir: '',
    jobsDirExists: false,
    latest: null,
    latestTerminal: null,
    rescanRunning: false,
    running: false,
    total: 0,
  },
  dbRecipeCount: 0,
  materializedRecipeCount: 0,
  recipeCount: 0,
  skillCount: 0,
  status: 'not_initialized',
  sourceRefs: {
    activeCount: 0,
    databasePath: '',
    reason: 'workspace has not been inspected',
    renamedCount: 0,
    staleCount: 0,
    staleRecipeCount: 0,
    status: 'missing',
    tableExists: false,
    totalCount: 0,
  },
  snapshots: {
    databasePath: '',
    latest: null,
    reason: 'workspace has not been inspected',
    status: 'missing',
    tableExists: false,
    totalCount: 0,
  },
  usable: false,
  vector: {
    documentCount: null,
    hnswIndexPath: '',
    indexDir: '',
    jsonIndexPath: '',
    memoryEmbeddingsPath: '',
    nonBlocking: true,
    ready: false,
    reason: 'workspace has not been inspected',
    skipped: false,
    status: 'missing',
    updatedAt: null,
  },
};

export function inspectKnowledge(projectRoot: string): HostKnowledgeState {
  let resolver: WorkspaceResolver;
  try {
    resolver = WorkspaceResolver.fromProject(projectRoot);
  } catch {
    resolver = new WorkspaceResolver({ projectRoot });
  }
  const initialized =
    existsSync(resolver.configPath) &&
    existsSync(resolver.databasePath) &&
    existsSync(resolver.knowledgeDir) &&
    existsSync(resolver.recipesDir);
  const recipeScan = scanMarkdownFiles(resolver.recipesDir, {
    excludeNames: new Set(['_template.md']),
  });
  const skillScan = scanSkillFiles(resolver.skillsDir);
  const materializedRecipeCount = recipeScan.count;
  const skillCount = skillScan.count;
  const databaseEntryCount = countProjectSkillKnowledgeEntries(resolver.dataRoot);
  const dbRecipeCount = countProjectDatabaseRecipes(resolver.dataRoot);
  const recipeCount = dbRecipeCount;
  const hasKnowledge =
    recipeCount > 0 || materializedRecipeCount > 0 || skillCount > 0 || databaseEntryCount > 0;
  const usable = initialized && hasKnowledge;
  const jobs = inspectJobActivity(resolver);
  const sourceRefs = inspectSourceRefs(resolver);
  const snapshots = inspectSnapshots(resolver);
  const latestKnowledgeMtimeMs = Math.max(
    recipeScan.latestMtimeMs,
    skillScan.latestMtimeMs,
    databaseEntryCount > 0 ? safeExistingMtimeMs(resolver.databasePath) : 0,
    0
  );
  const freshness = buildKnowledgeFreshness({
    jobs,
    latestKnowledgeAt:
      latestKnowledgeMtimeMs > 0 ? new Date(latestKnowledgeMtimeMs).toISOString() : null,
    sourceRefs,
    usable,
  });
  const vector = inspectVectorState(resolver, { usable });
  const status = resolveKnowledgeStatus({
    freshness,
    initialized,
    jobs,
    usable,
  });
  return {
    databaseEntryCount,
    dbRecipeCount,
    freshness,
    hasKnowledge,
    initialized,
    jobs,
    materializedRecipeCount,
    recipeCount,
    skillCount,
    status,
    sourceRefs,
    snapshots,
    usable,
    vector,
  };
}

function resolveKnowledgeStatus(input: {
  freshness: KnowledgeFreshness;
  initialized: boolean;
  jobs: JobActivityState;
  usable: boolean;
}): KnowledgeStatus {
  if (!input.initialized) {
    return 'not_initialized';
  }
  if (!input.usable && input.jobs.bootstrapRunning) {
    return 'bootstrap_running';
  }
  if (!input.usable) {
    return 'initialized_empty';
  }
  if (input.freshness.stale) {
    return 'knowledge_stale';
  }
  return 'knowledge_ready';
}

function scanMarkdownFiles(
  dir: string,
  options: { excludeNames?: Set<string> } = {}
): { count: number; latestMtimeMs: number } {
  try {
    return readdirSync(dir, { withFileTypes: true }).reduce((count, entry) => {
      if (entry.isDirectory()) {
        const child = scanMarkdownFiles(join(dir, entry.name), options);
        return {
          count: count.count + child.count,
          latestMtimeMs: Math.max(count.latestMtimeMs, child.latestMtimeMs),
        };
      }
      if (entry.isFile() && entry.name.endsWith('.md') && !options.excludeNames?.has(entry.name)) {
        const mtimeMs = safeMtimeMs(join(dir, entry.name));
        return {
          count: count.count + 1,
          latestMtimeMs: Math.max(count.latestMtimeMs, mtimeMs),
        };
      }
      return count;
    }, emptyScanResult());
  } catch {
    return emptyScanResult();
  }
}

function scanSkillFiles(dir: string): { count: number; latestMtimeMs: number } {
  try {
    return readdirSync(dir, { withFileTypes: true }).reduce((count, entry) => {
      if (!entry.isDirectory()) {
        return count;
      }
      const skillPath = join(dir, entry.name, 'SKILL.md');
      if (existsSync(skillPath)) {
        return {
          count: count.count + 1,
          latestMtimeMs: Math.max(count.latestMtimeMs, safeMtimeMs(skillPath)),
        };
      }
      const child = scanSkillFiles(join(dir, entry.name));
      return {
        count: count.count + child.count,
        latestMtimeMs: Math.max(count.latestMtimeMs, child.latestMtimeMs),
      };
    }, emptyScanResult());
  } catch {
    return emptyScanResult();
  }
}

function inspectJobActivity(resolver: WorkspaceResolver): JobActivityState {
  const jobsDir = join(resolver.runtimeDir, 'jobs');
  const jobsDirExists = existsSync(jobsDir);
  const jobs = jobsDirExists ? readJobSummaries(jobsDir) : [];
  const active = jobs.filter((job) => job.status === 'queued' || job.status === 'running');
  const latest = jobs[0] || null;
  const latestTerminal =
    jobs.find(
      (job) => job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
    ) || null;
  return {
    active,
    bootstrapRunning: active.some((job) => job.kind === 'bootstrap'),
    jobsDir,
    jobsDirExists,
    latest,
    latestTerminal,
    rescanRunning: active.some((job) => job.kind === 'rescan'),
    running: active.length > 0,
    total: jobs.length,
  };
}

function readJobSummaries(jobsDir: string): JobSummary[] {
  try {
    return readdirSync(jobsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => parseJobFile(join(jobsDir, entry.name)))
      .filter((job): job is JobSummary => Boolean(job))
      .sort((a, b) => jobTimeMs(b) - jobTimeMs(a));
  } catch {
    return [];
  }
}

function parseJobFile(filePath: string): JobSummary | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<DaemonJobRecord>;
    if (
      typeof parsed.id !== 'string' ||
      (parsed.kind !== 'bootstrap' && parsed.kind !== 'rescan') ||
      !isDaemonJobStatus(parsed.status)
    ) {
      return null;
    }
    return {
      id: parsed.id,
      kind: parsed.kind,
      status: parsed.status,
      ...(typeof parsed.source === 'string' ? { source: parsed.source } : {}),
      ...(typeof parsed.channelId === 'string' ? { channelId: parsed.channelId } : {}),
      ...(typeof parsed.client === 'string' ? { client: parsed.client } : {}),
      ...(typeof parsed.createdByTool === 'string' ? { createdByTool: parsed.createdByTool } : {}),
      ...(parsed.request ? { request: summarizeJobRequest(parsed.request) } : {}),
      ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId } : {}),
      ...(typeof parsed.createdAt === 'string' ? { createdAt: parsed.createdAt } : {}),
      ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
      ...(typeof parsed.completedAt === 'string' ? { completedAt: parsed.completedAt } : {}),
    };
  } catch {
    return null;
  }
}

function buildKnowledgeFreshness(input: {
  jobs: JobActivityState;
  latestKnowledgeAt: string | null;
  sourceRefs: SourceRefState;
  usable: boolean;
}): KnowledgeFreshness {
  const latestJob = input.jobs.latestTerminal || input.jobs.latest;
  const latestJobAt =
    latestJob?.completedAt || latestJob?.updatedAt || latestJob?.createdAt || null;
  if (!input.usable) {
    return {
      checkedAt: new Date().toISOString(),
      latestJobAt,
      latestKnowledgeAt: input.latestKnowledgeAt,
      reason: 'workspace does not have usable Codex knowledge yet',
      stale: false,
      status: 'unknown',
    };
  }
  if (input.sourceRefs.status === 'stale') {
    return {
      checkedAt: new Date().toISOString(),
      latestJobAt,
      latestKnowledgeAt: input.latestKnowledgeAt,
      reason: `${input.sourceRefs.staleCount} stale SourceRef(s) across ${input.sourceRefs.staleRecipeCount} Recipe(s)`,
      stale: true,
      status: 'source_refs_stale',
    };
  }
  if (input.jobs.running) {
    return {
      checkedAt: new Date().toISOString(),
      latestJobAt,
      latestKnowledgeAt: input.latestKnowledgeAt,
      reason: 'bootstrap or rescan job is running',
      stale: false,
      status: 'refresh_running',
    };
  }
  if (
    latestJob &&
    (latestJob.status === 'failed' || latestJob.status === 'cancelled') &&
    isAfter(latestJobAt, input.latestKnowledgeAt)
  ) {
    return {
      checkedAt: new Date().toISOString(),
      latestJobAt,
      latestKnowledgeAt: input.latestKnowledgeAt,
      reason: `latest ${latestJob.kind} job ${latestJob.status}`,
      stale: true,
      status: 'refresh_failed',
    };
  }
  return {
    checkedAt: new Date().toISOString(),
    latestJobAt,
    latestKnowledgeAt: input.latestKnowledgeAt,
    reason: null,
    stale: false,
    status: 'current',
  };
}

function summarizeJobRequest(request: unknown): JobSummary['request'] {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return {};
  }
  const value = request as Record<string, unknown>;
  return {
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(Array.isArray(value.dimensions)
      ? { dimensions: value.dimensions.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(typeof value.maxFiles === 'number' ? { maxFiles: value.maxFiles } : {}),
    ...(typeof value.contentMaxLines === 'number'
      ? { contentMaxLines: value.contentMaxLines }
      : {}),
    ...(typeof value.skipGuard === 'boolean' ? { skipGuard: value.skipGuard } : {}),
  };
}

function inspectSourceRefs(resolver: WorkspaceResolver): SourceRefState {
  return readSourceRefState(resolver.databasePath);
}

function inspectSnapshots(resolver: WorkspaceResolver): SnapshotState {
  return readSnapshotState(resolver.databasePath, resolver.projectRoot);
}

function inspectVectorState(resolver: WorkspaceResolver, input: { usable: boolean }): VectorState {
  const indexDir = join(resolver.contextDir, 'index');
  const jsonIndexPath = join(indexDir, 'vector_index.json');
  const hnswIndexPath = join(indexDir, 'vector_index.asvec');
  const memoryEmbeddingsPath = resolver.memoryEmbeddingsPath;
  const json = inspectJsonVectorIndex(jsonIndexPath);
  const hnswExists = existsSync(hnswIndexPath);
  const hnswMtime = hnswExists ? safeMtimeMs(hnswIndexPath) : 0;
  const memoryMtime = safeExistingMtimeMs(memoryEmbeddingsPath);
  const latestMtimeMs = Math.max(json.updatedAtMs, hnswMtime, memoryMtime, 0);

  if (json.status === 'unreadable') {
    return {
      documentCount: null,
      hnswIndexPath,
      indexDir,
      jsonIndexPath,
      memoryEmbeddingsPath,
      nonBlocking: true,
      ready: false,
      reason: 'vector index file exists but could not be parsed',
      skipped: input.usable,
      status: 'unreadable',
      updatedAt: latestMtimeMs > 0 ? new Date(latestMtimeMs).toISOString() : null,
    };
  }

  const documentCount = json.documentCount || 0;
  const ready = documentCount > 0 || hnswExists || existsSync(memoryEmbeddingsPath);
  if (ready) {
    return {
      documentCount: documentCount > 0 ? documentCount : null,
      hnswIndexPath,
      indexDir,
      jsonIndexPath,
      memoryEmbeddingsPath,
      nonBlocking: true,
      ready: true,
      reason: null,
      skipped: false,
      status: 'ready',
      updatedAt: latestMtimeMs > 0 ? new Date(latestMtimeMs).toISOString() : null,
    };
  }

  const status: VectorStatus = existsSync(indexDir) ? 'empty' : 'missing';
  return {
    documentCount: 0,
    hnswIndexPath,
    indexDir,
    jsonIndexPath,
    memoryEmbeddingsPath,
    nonBlocking: true,
    ready: false,
    reason: input.usable
      ? 'semantic vector index is not built; Codex tools remain available through lexical/database search'
      : 'semantic vector index is not built yet',
    skipped: input.usable,
    status,
    updatedAt: latestMtimeMs > 0 ? new Date(latestMtimeMs).toISOString() : null,
  };
}

function inspectJsonVectorIndex(filePath: string): {
  documentCount: number;
  status: 'missing' | 'ready' | 'unreadable';
  updatedAtMs: number;
} {
  if (!existsSync(filePath)) {
    return { documentCount: 0, status: 'missing', updatedAtMs: 0 };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    const documentCount = Array.isArray(parsed)
      ? parsed.length
      : parsed && typeof parsed === 'object'
        ? Object.keys(parsed).length
        : 0;
    return {
      documentCount,
      status: 'ready',
      updatedAtMs: safeMtimeMs(filePath),
    };
  } catch {
    return { documentCount: 0, status: 'unreadable', updatedAtMs: safeMtimeMs(filePath) };
  }
}

function emptyScanResult() {
  return { count: 0, latestMtimeMs: 0 };
}

function safeExistingMtimeMs(filePath: string): number {
  return existsSync(filePath) ? safeMtimeMs(filePath) : 0;
}

function safeMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function isAfter(left: string | null, right: string | null): boolean {
  if (!left) {
    return false;
  }
  if (!right) {
    return true;
  }
  return Date.parse(left) > Date.parse(right);
}

function jobTimeMs(job: JobSummary): number {
  return Date.parse(job.updatedAt || job.completedAt || job.createdAt || '') || 0;
}

function isDaemonJobStatus(value: unknown): value is DaemonJobStatus {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}
