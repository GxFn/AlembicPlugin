import { basename } from 'node:path';
import {
  baseDimensions,
  type DimensionDef,
  getOrCreateSessionManager,
  type HostAgentSessionContainer,
  resolvePlanDimensionDefinitions,
} from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import {
  buildProjectContextPresenterInput,
  type ProjectContextEnvelope,
  type ProjectContextPresenterInput,
  type ProjectContextRef,
  type ProjectContextRequestKind,
  type ProjectContextResult,
  type ProjectMap,
  type SpaceContext,
} from '@alembic/core/project-context';
import {
  collectPlanProjectContext,
  normalizeProjectContextPath,
  type PlanModuleSeed,
  type ProjectSourceFileFact,
} from '@alembic/core/service/planFacts';
import {
  failPluginStrictBypasses,
  openPluginCertifiedProjection,
  PLUGIN_CERTIFIED_ENTRYPOINTS,
  persistPluginCertifiedCarrier,
  readPluginCertifiedCarrierFromProjectContext,
  reopenPluginCertifiedConsumer,
} from '../../project-facts/PluginCertifiedProjectFactsRuntime.js';

interface BuildHostAgentProjectContextAnalysisInput {
  projectRoot: string;
  source: 'codex-host-bootstrap' | 'codex-host-rescan';
  moduleScope?: readonly string[];
  maxFiles?: unknown;
  maxModuleSeeds?: number;
  maxModuleDetails?: number;
  maxFileDetails?: number;
  sourceFolders?: readonly string[];
  certifiedSession?: {
    container: HostAgentSessionContainer;
    dataRoot: string;
    strict?: boolean;
  };
}

export interface ProjectContextModuleSeed {
  configLayer?: string;
  kind?: string;
  /** 划分给出的模块文件数（F6 起由 Core 给出）。 */
  fileCount?: number;
  // canonical ProjectMap 模块 id（F6 起直接取自仓库划分的模块引用）。additive。
  moduleId?: string;
  moduleName: string;
  modulePath?: string;
  ownedFiles?: string[];
  ref?: ProjectContextRef;
  role?: string;
}

export interface HostAgentProjectContextAnalysis {
  dimensions: DimensionDef[];
  envelopes: ProjectContextEnvelope<ProjectContextResult>[];
  fileCount: number;
  isEmpty: boolean;
  isMultiLang: boolean;
  moduleCount: number;
  moduleSeeds: ProjectContextModuleSeed[];
  presenterInput: ProjectContextPresenterInput;
  primaryLang: string;
  projectType: string;
  requestKinds: ProjectContextRequestKind[];
  secondaryLanguages: string[];
  sourceFileFacts: ProjectSourceFileFact[];
}

export interface HostAgentSessionLeaseRelease {
  released: boolean;
  sessionId?: string;
  /** 加性字段：session 因承载有效的 Plugin certified carrier 而被保留（未释放）时给出原因。 */
  protectedReason?: 'plugin-certified-carrier';
}

export function createProjectContextHostAgentSession(input: {
  container: HostAgentSessionContainer;
  dimensions: DimensionDef[];
  fileCount: number;
  moduleCount: number;
  primaryLang: string | null;
  producerCapability: 'cold-start' | 'incremental';
  projectRoot: string;
}): ReturnType<ReturnType<typeof getOrCreateSessionManager>['createSession']> {
  const sessionManager = getOrCreateSessionManager(input.container);
  const certifiedSession = sessionManager.getAnySession(undefined, {
    projectRoot: input.projectRoot,
  });
  if (
    certifiedSession &&
    readPluginCertifiedCarrierFromProjectContext(certifiedSession.toSnapshot().projectContext)
  ) {
    return certifiedSession;
  }
  releaseEmptyHostAgentSessionLease({
    projectRoot: input.projectRoot,
    sessionManager,
  });
  try {
    return createSession(input, sessionManager);
  } catch (err: unknown) {
    const release = releaseEmptyHostAgentSessionLease({
      projectRoot: input.projectRoot,
      sessionManager,
    });
    if (!release.released || !isBootstrapInProgressError(err)) {
      throw err;
    }
    return createSession(input, sessionManager);
  }
}

export function releaseEmptyHostAgentSessionLeaseForProject(input: {
  allowFreshEmpty?: boolean;
  container: HostAgentSessionContainer;
  logger?: { info?(msg: string, meta?: Record<string, unknown>): void };
  projectRoot: string;
  reason?: string;
  source: 'alembic_bootstrap' | 'alembic_rescan';
}): HostAgentSessionLeaseRelease {
  const sessionManager = getOrCreateSessionManager(input.container);
  const release = releaseEmptyHostAgentSessionLease({
    projectRoot: input.projectRoot,
    sessionManager,
    staleAfterMs: input.allowFreshEmpty === true ? 0 : undefined,
  });
  if (release.protectedReason) {
    input.logger?.info?.('[GenerateSession] Kept Plugin-certified host-agent session lease', {
      allowFreshEmpty: input.allowFreshEmpty === true,
      projectRoot: input.projectRoot,
      protectedReason: release.protectedReason,
      reason: input.reason ?? 'stale-empty-host-agent-session',
      sessionId: release.sessionId,
      source: input.source,
    });
  }
  if (release.released) {
    input.logger?.info?.('[GenerateSession] Released stale empty host-agent lease', {
      allowFreshEmpty: input.allowFreshEmpty === true,
      projectRoot: input.projectRoot,
      reason: input.reason ?? 'stale-empty-host-agent-session',
      sessionId: release.sessionId,
      source: input.source,
    });
  }
  return release;
}

export function releaseEmptyHostAgentSessionLeaseById(input: {
  container: HostAgentSessionContainer;
  logger?: { info?(msg: string, meta?: Record<string, unknown>): void };
  projectRoot: string;
  reason: string;
  sessionId: string;
  source: 'alembic_bootstrap' | 'alembic_rescan';
}): HostAgentSessionLeaseRelease {
  const sessionManager = getOrCreateSessionManager(input.container);
  const session = readProjectSessionById(sessionManager, input.sessionId, input.projectRoot);
  if (!isRecord(session) || !isEmptyHostAgentSession(session)) {
    return { released: false };
  }
  // Plan 创建的认证 session 没有维度/提交，看起来是“空”的，但它承载严格模式唯一的 certified
  // carrier；释放它会让后续严格生成 fail closed，所以按 id 释放也必须保留它。
  const protectedReason = readHostAgentSessionReleaseProtection(session, input.sessionId);
  if (protectedReason) {
    input.logger?.info?.('[GenerateSession] Kept Plugin-certified host-agent session lease by id', {
      projectRoot: input.projectRoot,
      protectedReason,
      reason: input.reason,
      sessionId: input.sessionId,
      source: input.source,
    });
    return { protectedReason, released: false, sessionId: input.sessionId };
  }
  if (typeof sessionManager.clearSession !== 'function') {
    return { released: false };
  }
  sessionManager.clearSession(input.sessionId);
  input.logger?.info?.('[GenerateSession] Released empty host-agent lease by id', {
    projectRoot: input.projectRoot,
    reason: input.reason,
    sessionId: input.sessionId,
    source: input.source,
  });
  return { released: true, sessionId: input.sessionId };
}

function createSession(
  input: {
    container: HostAgentSessionContainer;
    dimensions: DimensionDef[];
    fileCount: number;
    moduleCount: number;
    primaryLang: string | null;
    producerCapability: 'cold-start' | 'incremental';
    projectRoot: string;
  },
  sessionManager: ReturnType<typeof getOrCreateSessionManager>
) {
  return sessionManager.createSession({
    dimensions: input.dimensions.map((dimension) => ({
      ...dimension,
      skillMeta: dimension.skillMeta ?? undefined,
    })),
    projectContext: {
      fileCount: input.fileCount,
      modules: input.moduleCount,
      primaryLang: input.primaryLang,
      recipeProducerCapability: input.producerCapability,
      projectInformationSource: 'project-context',
      projectName: basename(input.projectRoot),
    },
    projectRoot: input.projectRoot,
  });
}

export function releaseEmptyHostAgentSessionLease(input: {
  projectRoot: string;
  sessionManager: {
    clearSession?: (sessionId?: string) => void;
    getSession?: (sessionId?: string, options?: { projectRoot?: string }) => unknown;
  };
  now?: number;
  staleAfterMs?: number;
}): HostAgentSessionLeaseRelease {
  const staleAfterMs = input.staleAfterMs ?? 5 * 60 * 1000;
  const session = readProjectSession(input.sessionManager, input.projectRoot);
  if (!session || !isEmptyStaleHostAgentSession(session, input.now ?? Date.now(), staleAfterMs)) {
    return { released: false };
  }

  const sessionId = readStringValue((session as Record<string, unknown>).id);
  // 所有 releaseEmpty* 入口（rescan 入口 allowFreshEmpty、bootstrap、
  // createProjectContextHostAgentSession 的重试）都经过这里：携带 Plugin certified carrier 的
  // session 不是可回收的空租约，必须保留给严格生成读取。
  const protectedReason = readHostAgentSessionReleaseProtection(
    session as Record<string, unknown>,
    sessionId
  );
  if (protectedReason) {
    return { protectedReason, released: false, ...(sessionId ? { sessionId } : {}) };
  }
  if (!sessionId || typeof input.sessionManager.clearSession !== 'function') {
    return { released: false };
  }
  input.sessionManager.clearSession(sessionId);
  return { released: true, sessionId };
}

export async function buildHostAgentProjectContextAnalysis(
  input: BuildHostAgentProjectContextAnalysisInput
): Promise<HostAgentProjectContextAnalysis> {
  const certified = await tryBuildCertifiedHostAgentProjectContextAnalysis(input);
  if (certified) {
    return certified;
  }
  // F6（2026-10-06）：非认证分支的采集交给 Core 的共用采集器——请求顺序、种子（仓库的模块划分）、
  // 源码清单、语言统计都在 Core；这里只留 Plugin 自己的上限（模块明细 3、文件明细 8、不取正文）与范围
  // （sourceFolders 原样作为 space 的文件夹，第一个是 repo 的主仓库；moduleScope 过滤模块）。
  // 模块种子默认不设上限（2026-10-07，与主体一致）：划分出的模块数本身有界，旧上限 25 在大项目上会按
  // 文件数挤掉模块；调用方仍可显式传 maxModuleSeeds。
  const maxFiles = readPositiveInteger(input.maxFiles);
  const sourceFolders = normalizeProjectContextSourceFolders(input.sourceFolders);
  const moduleScope = (input.moduleScope ?? []).map(normalizeProjectContextPath).filter(isPresent);
  const analysis = await collectPlanProjectContext(input.projectRoot, undefined, {
    limits: {
      ...(maxFiles !== undefined ? { maxFiles } : {}),
      maxFileDetails: input.maxFileDetails ?? 8,
      maxModuleDetails: input.maxModuleDetails ?? 3,
      ...(input.maxModuleSeeds !== undefined ? { maxModuleSeeds: input.maxModuleSeeds } : {}),
      sourceSliceLines: 0,
    },
    scope: {
      displayName: basename(input.projectRoot),
      ...(sourceFolders.length > 0 ? { repoRoot: sourceFolders[0], sourceFolders } : {}),
      ...(moduleScope.length > 0 ? { moduleScope } : {}),
    },
    source: input.source,
  });
  const primaryLang = analysis.primaryLanguage;
  return {
    dimensions: resolveProjectContextDimensions(primaryLang),
    envelopes: analysis.envelopes,
    fileCount: analysis.fileCount,
    isEmpty:
      analysis.isEmpty ??
      (analysis.presenterInput.files.length === 0 && analysis.presenterInput.refs.length === 0),
    isMultiLang: analysis.isMultiLang ?? analysis.secondaryLanguages.length > 0,
    moduleCount: analysis.moduleCount,
    moduleSeeds: analysis.moduleSeeds.map(toHostAgentModuleSeed),
    presenterInput: analysis.presenterInput,
    primaryLang,
    projectType: analysis.projectType,
    requestKinds: analysis.requestKinds,
    secondaryLanguages: analysis.secondaryLanguages,
    sourceFileFacts: analysis.sourceFileFacts,
  };
}

function toHostAgentModuleSeed(seed: PlanModuleSeed): ProjectContextModuleSeed {
  return {
    ...(seed.kind ? { kind: seed.kind } : {}),
    ...(seed.fileCount !== undefined ? { fileCount: seed.fileCount } : {}),
    ...(seed.moduleId ? { moduleId: seed.moduleId } : {}),
    moduleName: seed.moduleName,
    ...(seed.modulePath ? { modulePath: seed.modulePath } : {}),
    ...(seed.ownedFiles ? { ownedFiles: [...seed.ownedFiles] } : {}),
    ...(seed.ref ? { ref: seed.ref } : {}),
    ...(seed.role ? { role: seed.role } : {}),
  };
}

async function tryBuildCertifiedHostAgentProjectContextAnalysis(
  input: BuildHostAgentProjectContextAnalysisInput
): Promise<HostAgentProjectContextAnalysis | null> {
  if (!input.certifiedSession) {
    return null;
  }
  const session = getOrCreateSessionManager(input.certifiedSession.container).getAnySession(
    undefined,
    { projectRoot: input.projectRoot }
  );
  const carrier = session
    ? readPluginCertifiedCarrierFromProjectContext(session.toSnapshot().projectContext)
    : null;
  if (!carrier) {
    if (input.certifiedSession.strict) {
      failPluginStrictBypasses({
        bypasses: [
          'direct-project-context',
          'raw-filesystem',
          'synthetic-project-scope',
          'capped-module-axis',
        ],
        entrypoint: PLUGIN_CERTIFIED_ENTRYPOINTS['recipe-generation'],
        message:
          'Loaded strict generation requires the Plan-created certified carrier before analysis.',
      });
    }
    return null;
  }
  const projection = carrier.receipts['recipe-generation']
    ? await openPluginCertifiedProjection({
        carrier,
        dataRoot: input.certifiedSession.dataRoot,
      })
    : (
        await reopenPluginCertifiedConsumer({
          carrier,
          consumer: 'recipe-generation',
          dataRoot: input.certifiedSession.dataRoot,
          entrypoint: PLUGIN_CERTIFIED_ENTRYPOINTS['recipe-generation'],
          runId: `${session?.id ?? 'generation'}-recipe-generation`,
        })
      ).projection;
  if (!session) {
    throw new TypeError('Certified generation carrier is detached from its HostAgent session.');
  }
  persistPluginCertifiedCarrier({ carrier, projectRoot: input.projectRoot, session });
  const presenterInput = buildProjectContextPresenterInput(projection.envelopes);
  const languageCounts = projection.files.reduce<Record<string, number>>((counts, file) => {
    counts[file.language] = (counts[file.language] ?? 0) + 1;
    return counts;
  }, {});
  const primaryLang =
    Object.entries(languageCounts).sort(
      ([left, leftCount], [right, rightCount]) =>
        rightCount - leftCount || left.localeCompare(right)
    )[0]?.[0] ?? 'unknown';
  const secondaryLanguages = Object.keys(languageCounts)
    .filter((language) => language !== primaryLang)
    .sort();
  const dimensions = resolveProjectContextDimensions(primaryLang);
  return {
    dimensions,
    envelopes: projection.envelopes,
    fileCount: projection.files.length,
    isEmpty: projection.files.length === 0,
    isMultiLang: secondaryLanguages.length > 0,
    moduleCount: projection.modules.length,
    moduleSeeds: projection.modules.map((module) => {
      const firstOwnedFile = module.ownedFiles[0];
      return {
        kind: 'certified-module',
        moduleId: module.id,
        moduleName: module.name,
        modulePath: firstOwnedFile ? firstOwnedFile.split('/').slice(0, -1).join('/') || '.' : '.',
        ownedFiles: [...module.ownedFiles],
        role: 'certified-module',
      };
    }),
    presenterInput,
    primaryLang,
    projectType: 'certified-project',
    requestKinds: projection.requestKinds,
    secondaryLanguages,
    sourceFileFacts: projection.files.map((file) => ({
      filePath:
        file.repositoryRelativeRoot === '.'
          ? file.relativePath
          : `${file.repositoryRelativeRoot}/${file.relativePath}`,
      language: file.language,
      sizeBytes: file.byteLength,
    })),
  };
}

export function selectProjectContextDimensions(
  dimensions: readonly DimensionDef[],
  requestedDimensionIds?: readonly string[]
): DimensionDef[] {
  if (!requestedDimensionIds?.length) {
    return [...dimensions];
  }
  return resolvePlanDimensionDefinitions(baseDimensions, requestedDimensionIds).dimensions;
}

function readProjectSession(
  sessionManager: {
    getSession?: (sessionId?: string, options?: { projectRoot?: string }) => unknown;
  },
  projectRoot: string
): unknown {
  if (typeof sessionManager.getSession !== 'function') {
    return null;
  }
  try {
    return sessionManager.getSession(undefined, { projectRoot });
  } catch {
    try {
      const session = sessionManager.getSession();
      return sessionBelongsToProject(session, projectRoot) ? session : null;
    } catch {
      return null;
    }
  }
}

function isEmptyStaleHostAgentSession(
  session: unknown,
  now: number,
  staleAfterMs: number
): boolean {
  if (!isRecord(session)) {
    return false;
  }
  const startedAt = readNumberValue(session.startedAt);
  if (!startedAt || now - startedAt < staleAfterMs) {
    return false;
  }
  return isEmptyHostAgentSession(session);
}

function isEmptyHostAgentSession(session: Record<string, unknown>): boolean {
  if (readCompletedDimensionCount(session.completedDimensions) > 0) {
    return false;
  }
  const progress = readCallableRecord(session, 'getProgress');
  if ((readNumberValue(progress?.completed) ?? 0) > 0) {
    return false;
  }
  return (
    !sessionStoreHasEvidence(session.sessionStore) &&
    !submissionTrackerHasEvidence(session.submissionTracker)
  );
}

/**
 * 判断一个“空” HostAgent session 是否因承载有效的 Plugin certified carrier 而禁止释放。
 * 只保护通过 readPluginCertifiedCarrierFromProjectContext 校验的 carrier：校验失败的 carrier
 * （例如插件升级后残留的旧格式 preparationId）会让 Plan draft、严格 rescan、cold start 读取时同样抛错，
 * 若保留该 session 则在 TTL 过期前无路可恢复；因此照旧释放，并用 warn 保留校验错误作为诊断依据，
 * 之后重新运行 alembic_plan 即可重新捕获 carrier。
 */
function readHostAgentSessionReleaseProtection(
  session: Record<string, unknown>,
  sessionId: string | undefined
): HostAgentSessionLeaseRelease['protectedReason'] {
  const projectContext = readHostAgentSessionProjectContext(session);
  try {
    if (!readPluginCertifiedCarrierFromProjectContext(projectContext)) {
      return undefined;
    }
  } catch (err: unknown) {
    Logger.warn(
      '[GenerateSession] Empty host-agent session has an invalid certified carrier; not protected, releasing as empty lease',
      {
        error: err instanceof Error ? err.message : String(err),
        sessionId,
      }
    );
    return undefined;
  }
  Logger.info('[GenerateSession] Kept Plugin-certified host-agent session instead of releasing', {
    sessionId,
  });
  return 'plugin-certified-carrier';
}

function readHostAgentSessionProjectContext(session: Record<string, unknown>): unknown {
  // GenerateSession 的 projectContext 是私有字段，只能通过 toSnapshot() 读取；
  // 其他形状（测试替身、旧快照）退回可枚举的 projectContext 字段。
  const snapshot = readCallableRecord(session, 'toSnapshot');
  if (snapshot && 'projectContext' in snapshot) {
    return snapshot.projectContext;
  }
  return session.projectContext;
}

function readProjectSessionById(
  sessionManager: {
    getSession?: (sessionId?: string, options?: { projectRoot?: string }) => unknown;
  },
  sessionId: string,
  projectRoot: string
): unknown {
  if (typeof sessionManager.getSession !== 'function') {
    return null;
  }
  try {
    return sessionManager.getSession(sessionId, { projectRoot });
  } catch {
    try {
      const session = sessionManager.getSession(sessionId);
      return sessionBelongsToProject(session, projectRoot) ? session : null;
    } catch {
      return null;
    }
  }
}

function sessionBelongsToProject(session: unknown, projectRoot: string): boolean {
  return isRecord(session) && readStringValue(session.projectRoot) === projectRoot;
}

function sessionStoreHasEvidence(value: unknown): boolean {
  const snapshot = readJsonLike(value);
  if (!snapshot) {
    return false;
  }
  return (
    recordHasValues(snapshot.dimensionReports) ||
    recordHasCandidateValues(snapshot.submittedCandidates) ||
    arrayHasValues(snapshot.crossReferences) ||
    arrayHasValues(snapshot.tierReflections)
  );
}

function submissionTrackerHasEvidence(value: unknown): boolean {
  const snapshot = readJsonLike(value);
  if (!snapshot) {
    return false;
  }
  return (
    recordHasCandidateValues(snapshot.dimensionSubmissions) ||
    recordHasCandidateValues(snapshot.fileEvidenceMap) ||
    recordHasCandidateValues(snapshot.rejections) ||
    arrayHasValues(snapshot.negativeSignals) ||
    arrayHasValues(snapshot.usedTriggers)
  );
}

function readJsonLike(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (isRecord(value) && typeof value.toJSON === 'function') {
    const snapshot = value.toJSON();
    return isRecord(snapshot) ? snapshot : null;
  }
  return isRecord(value) ? value : null;
}

function readCallableRecord(
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  const fn = value[key];
  if (typeof fn !== 'function') {
    return null;
  }
  try {
    const result = fn.call(value);
    return isRecord(result) ? result : null;
  } catch {
    return null;
  }
}

function readCompletedDimensionCount(value: unknown): number {
  if (value instanceof Map) {
    return value.size;
  }
  return isRecord(value) ? Object.keys(value).length : 0;
}

function recordHasValues(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function recordHasCandidateValues(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some((entry) =>
    Array.isArray(entry) ? entry.length > 0 : Boolean(entry)
  );
}

function arrayHasValues(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isBootstrapInProgressError(err: unknown): boolean {
  return (
    isRecord(err) &&
    (err.code === 'BOOTSTRAP_IN_PROGRESS' || err.errorCode === 'BOOTSTRAP_IN_PROGRESS')
  );
}

function resolveProjectContextDimensions(_primaryLang: string): DimensionDef[] {
  return [...baseDimensions];
}

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeProjectContextSourceFolders(
  sourceFolders: readonly string[] | undefined
): string[] {
  if (!sourceFolders?.length) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const sourceFolder of sourceFolders) {
    const value = normalizeProjectContextPath(sourceFolder);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function isSpaceContext(value: ProjectContextResult): value is SpaceContext {
  return 'space' in value && 'sourceFolders' in value;
}

export function isProjectMapContext(value: ProjectContextResult): value is ProjectMap {
  return 'modules' in value && 'dependencySummary' in value && 'majorFlows' in value;
}
