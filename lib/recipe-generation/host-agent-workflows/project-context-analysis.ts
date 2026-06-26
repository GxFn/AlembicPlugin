import { basename } from 'node:path';
import {
  baseDimensions,
  type DimensionDef,
  getOrCreateSessionManager,
  type HostAgentSessionContainer,
  resolvePlanDimensionDefinitions,
} from '@alembic/core/host-agent-workflows';
import {
  buildProjectContextPresenterInput,
  type ModuleContext,
  type ProjectContextEnvelope,
  type ProjectContextPresenterInput,
  type ProjectContextRef,
  type ProjectContextRequestKind,
  type ProjectContextResult,
  type ProjectMap,
  type RepoContext,
  type SpaceContext,
} from '@alembic/core/project-context';
import { ProjectContextCapabilities } from '@alembic/core/project-context-capabilities';
import {
  attachSourceFilesToProjectContextModuleSeeds,
  collectProjectSourceFileFacts,
  normalizeProjectContextPath,
  type ProjectSourceFileFact,
} from '#recipe-generation/project-source-facts.js';

interface BuildHostAgentProjectContextAnalysisInput {
  projectRoot: string;
  source: 'codex-host-bootstrap' | 'codex-host-rescan';
  moduleScope?: readonly string[];
  maxFiles?: unknown;
  maxModuleSeeds?: number;
  maxModuleDetails?: number;
  maxFileDetails?: number;
}

export interface ProjectContextModuleSeed {
  configLayer?: string;
  kind?: string;
  // U1 #6：canonical ProjectMap 模块 id（命中 canonical 时回填；派生 seed 默认无）。additive。
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

export function createProjectContextHostAgentSession(input: {
  container: HostAgentSessionContainer;
  dimensions: DimensionDef[];
  fileCount: number;
  moduleCount: number;
  primaryLang: string | null;
  projectRoot: string;
}): ReturnType<ReturnType<typeof getOrCreateSessionManager>['createSession']> {
  const sessionManager = getOrCreateSessionManager(input.container);
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
  container: HostAgentSessionContainer;
  logger?: { info?(msg: string, meta?: Record<string, unknown>): void };
  projectRoot: string;
  source: 'alembic_bootstrap' | 'alembic_rescan';
}): { released: boolean; sessionId?: string } {
  const sessionManager = getOrCreateSessionManager(input.container);
  const release = releaseEmptyHostAgentSessionLease({
    projectRoot: input.projectRoot,
    sessionManager,
  });
  if (release.released) {
    input.logger?.info?.('[BootstrapSession] Released stale empty host-agent lease', {
      projectRoot: input.projectRoot,
      sessionId: release.sessionId,
      source: input.source,
    });
  }
  return release;
}

function createSession(
  input: {
    container: HostAgentSessionContainer;
    dimensions: DimensionDef[];
    fileCount: number;
    moduleCount: number;
    primaryLang: string | null;
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
}): { released: boolean; sessionId?: string } {
  const staleAfterMs = input.staleAfterMs ?? 5 * 60 * 1000;
  const session = readProjectSession(input.sessionManager, input.projectRoot);
  if (!session || !isEmptyStaleHostAgentSession(session, input.now ?? Date.now(), staleAfterMs)) {
    return { released: false };
  }

  const sessionId = readStringValue((session as Record<string, unknown>).id);
  if (!sessionId || typeof input.sessionManager.clearSession !== 'function') {
    return { released: false };
  }
  input.sessionManager.clearSession(sessionId);
  return { released: true, sessionId };
}

export async function buildHostAgentProjectContextAnalysis(
  input: BuildHostAgentProjectContextAnalysisInput
): Promise<HostAgentProjectContextAnalysis> {
  const maxModuleSeeds = input.maxModuleSeeds ?? 25;
  const maxModuleDetails = input.maxModuleDetails ?? 3;
  const maxFileDetails = input.maxFileDetails ?? 8;
  const maxFiles = readPositiveInteger(input.maxFiles);
  const basePayload = {
    ...(maxFiles !== undefined ? { maxFiles } : {}),
  };
  const spaceEnvelope = await executeProjectContextRequest(
    'space',
    input.projectRoot,
    input.source,
    {
      includeProjectTree: true,
    }
  );
  const firstRepoEnvelope = await executeProjectContextRequest(
    'repo',
    input.projectRoot,
    input.source,
    {
      ...basePayload,
      includeMapSummary: false,
    }
  );
  const repoData = isRepoContext(firstRepoEnvelope.data) ? firstRepoEnvelope.data : undefined;
  const sourceFileFacts = await collectProjectSourceFileFacts(input.projectRoot);
  const selectedModuleSeeds = selectProjectContextModuleSeeds(repoData, input.moduleScope);
  const moduleScopeFallbackSeeds = createModuleScopeFallbackSeeds(
    input.moduleScope,
    selectedModuleSeeds,
    sourceFileFacts
  );
  const discoveredModuleSeeds = attachSourceFilesToProjectContextModuleSeeds(
    dedupeModuleSeeds([...selectedModuleSeeds, ...moduleScopeFallbackSeeds]),
    sourceFileFacts
  );
  const moduleSeeds = discoveredModuleSeeds.slice(0, maxModuleSeeds);
  const repoEnvelope =
    moduleSeeds.length > 0
      ? await executeProjectContextRequest('repo', input.projectRoot, input.source, {
          ...basePayload,
          includeMapSummary: true,
          moduleSeeds,
        })
      : firstRepoEnvelope;
  const envelopes: ProjectContextEnvelope<ProjectContextResult>[] = [spaceEnvelope, repoEnvelope];

  if (moduleSeeds.length > 0) {
    envelopes.push(
      await executeProjectContextRequest('map', input.projectRoot, input.source, {
        moduleSeeds,
        repoName: repoData?.repo.name,
      })
    );
  }

  for (const seed of moduleSeeds.slice(0, maxModuleDetails)) {
    envelopes.push(
      await executeProjectContextRequest('module', input.projectRoot, input.source, {
        ...seed,
        includeDependencies: true,
        includePublicSurfaces: true,
      })
    );
    envelopes.push(
      await executeProjectContextRequest('module-layers', input.projectRoot, input.source, {
        ...seed,
        includeBoundaryCrossings: true,
      })
    );
  }

  const detailFiles = selectProjectContextDetailFiles(envelopes, maxFileDetails);
  for (const filePath of detailFiles) {
    envelopes.push(
      await executeProjectContextRequest('file-flow', input.projectRoot, input.source, {
        filePath,
      })
    );
    envelopes.push(
      await executeProjectContextRequest('file-symbols', input.projectRoot, input.source, {
        filePath,
      })
    );
    envelopes.push(
      await executeProjectContextRequest('source-slice', input.projectRoot, input.source, {
        endLine: 1,
        filePath,
        includeText: false,
        startLine: 1,
      })
    );
    envelopes.push(
      await executeProjectContextRequest('anchor-range', input.projectRoot, input.source, {
        afterLines: 2,
        beforeLines: 0,
        filePath,
        includeRelations: false,
        includeSourceSlices: true,
        includeSymbols: true,
        line: 1,
        relationHops: 0,
      })
    );
  }

  const presenterInput = buildProjectContextPresenterInput(envelopes);
  const primaryLang = inferProjectContextPrimaryLanguage(presenterInput);
  const secondaryLanguages = inferProjectContextSecondaryLanguages(presenterInput, primaryLang);
  const dimensions = resolveProjectContextDimensions(primaryLang);
  // U1 #6（方案A）：保留派生出的 moduleSeeds（仍用于 map 查询），但把对外返回的 seed 的 name/id
  // 统一对齐到 canonical ProjectMap.modules（按归一化 path 匹配；命中则覆盖为 canonical name+id，
  // 未命中保留 seed 自身派生名）。不退役 seed（退役=方案B，属另一需求）。map 不可用时原样返回。
  const canonicalModuleSeeds = canonicalizeModuleSeedRefs(moduleSeeds, presenterInput.map?.modules);
  return {
    dimensions,
    envelopes,
    fileCount: Math.max(
      presenterInput.files.length,
      countRepoLanguageFiles(repoData),
      sourceFileFacts.length
    ),
    isEmpty: presenterInput.files.length === 0 && presenterInput.refs.length === 0,
    isMultiLang: secondaryLanguages.length > 0,
    moduleCount: Math.max(
      presenterInput.modules.length,
      presenterInput.map?.modules.length ?? 0,
      discoveredModuleSeeds.length
    ),
    moduleSeeds: canonicalModuleSeeds,
    presenterInput,
    primaryLang,
    projectType: inferProjectContextProjectType(presenterInput),
    requestKinds: uniqueRequestKinds(envelopes.map((envelope) => envelope.queryLevel)),
    secondaryLanguages,
    sourceFileFacts,
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

async function executeProjectContextRequest(
  kind: ProjectContextRequestKind,
  projectRoot: string,
  source: BuildHostAgentProjectContextAnalysisInput['source'],
  payload?: Record<string, unknown>
): Promise<ProjectContextEnvelope<ProjectContextResult>> {
  return ProjectContextCapabilities.execute({
    kind,
    payload,
    project: {
      displayName: basename(projectRoot),
      projectRoot,
      source,
    },
    scope: {
      projectRoot,
    },
  });
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

function selectProjectContextModuleSeeds(
  repo: RepoContext | undefined,
  moduleScope?: readonly string[]
): ProjectContextModuleSeed[] {
  if (!repo) {
    return [];
  }
  const requestedScope = new Set((moduleScope ?? []).map(normalizeModulePath).filter(isPresent));
  const candidates: ProjectContextModuleSeed[] = [
    ...repo.localPackages.map((pkg) => ({
      kind: 'local-package',
      moduleName: pkg.name,
      modulePath: normalizeModulePath(pkg.path ?? pkg.ref?.scope.filePath),
      ref: pkg.ref,
      role: 'local-package',
    })),
    ...repo.sourceRoots.map((root) => ({
      kind: 'source-root',
      moduleName: moduleNameFromPath(root.path, root.role ?? 'source'),
      modulePath: normalizeModulePath(root.path),
      ref: root.ref,
      role: root.role ?? 'source-root',
    })),
    ...repo.topAreas.map((area) => ({
      kind: 'top-area',
      moduleName: moduleNameFromPath(area.path, area.role ?? 'area'),
      modulePath: normalizeModulePath(area.path),
      ref: area.ref,
      role: area.role ?? 'top-area',
    })),
    ...repo.entrypoints.flatMap((entrypoint) =>
      entrypoint.refs.flatMap((ref) => seedFromFileRef(ref, entrypoint.name, entrypoint.kind))
    ),
    ...repo.targets.flatMap((target) =>
      target.refs.flatMap((ref) => seedFromFileRef(ref, target.name, target.kind ?? 'target'))
    ),
  ].filter(hasUsableSeedScope);

  const scopedCandidates =
    requestedScope.size > 0
      ? candidates.filter((seed) => seedMatchesRequestedScope(seed, requestedScope))
      : candidates;
  return dedupeModuleSeeds(scopedCandidates);
}

function createModuleScopeFallbackSeeds(
  moduleScope: readonly string[] | undefined,
  selectedSeeds: readonly ProjectContextModuleSeed[],
  sourceFileFacts: readonly ProjectSourceFileFact[]
): ProjectContextModuleSeed[] {
  const requestedScopes = (moduleScope ?? []).map(normalizeModulePath).filter(isPresent);
  if (requestedScopes.length === 0) {
    return [];
  }
  return requestedScopes
    .filter(
      (scope) => !selectedSeeds.some((seed) => seedMatchesRequestedScope(seed, new Set([scope])))
    )
    .filter((scope) =>
      sourceFileFacts.some(
        (file) => file.filePath === scope || file.filePath.startsWith(`${scope}/`)
      )
    )
    .map((scope) => ({
      kind: 'module-scope-fallback',
      moduleName: moduleNameFromPath(scope, 'module-scope'),
      modulePath: scope,
      role: 'module-scope',
    }));
}

// U1 #6（方案A）：把派生 seed 的 name/id 对齐 canonical ProjectMap.modules。
// 对每个 seed，用其归一化 modulePath（或 ownedFiles 首项）匹配 canonical 模块的归一化路径
// （path = module.ref.scope.filePath）；命中则覆盖 moduleName=canonical.name、moduleId=canonical.id。
// 多候选取最长路径（最具体模块）。未命中保留 seed 原派生名（不丢失 seed）。canonical 列表为空时原样返回。
export function canonicalizeModuleSeedRefs(
  seeds: readonly ProjectContextModuleSeed[],
  canonicalModules: ProjectMap['modules'] | undefined
): ProjectContextModuleSeed[] {
  if (!canonicalModules || canonicalModules.length === 0) {
    return [...seeds];
  }
  // 预计算 (归一化 canonical path → {name,id})，按 path 长度降序。
  const canonicalByPath = canonicalModules
    .map((module) => ({
      id: module.id,
      name: module.name,
      path: normalizeModulePath(module.ref?.scope.filePath),
    }))
    .filter((entry): entry is { id: string; name: string; path: string } => isPresent(entry.path))
    .sort((left, right) => right.path.length - left.path.length);
  if (canonicalByPath.length === 0) {
    return [...seeds];
  }
  return seeds.map((seed) => {
    const seedPaths = [
      normalizeModulePath(seed.modulePath),
      ...(seed.ownedFiles ?? []).map(normalizeModulePath),
    ].filter(isPresent);
    const match = canonicalByPath.find((entry) =>
      seedPaths.some(
        (seedPath) =>
          seedPath === entry.path ||
          seedPath.startsWith(`${entry.path}/`) ||
          entry.path.startsWith(`${seedPath}/`)
      )
    );
    if (!match) {
      return seed;
    }
    // 命中 canonical：把 seed 的 name/id 对齐到 ProjectMap 权威值（modulePath/ownedFiles 等其余字段不变）。
    return { ...seed, moduleId: match.id, moduleName: match.name };
  });
}

function seedFromFileRef(
  ref: ProjectContextRef,
  moduleName: string,
  role: string
): ProjectContextModuleSeed[] {
  const filePath = ref.scope.filePath;
  if (!filePath) {
    return [];
  }
  const modulePath = inferModulePathFromProjectContextRef(filePath);
  return [
    {
      kind: 'file-anchor',
      moduleName,
      ...(modulePath ? { modulePath } : {}),
      ownedFiles: [filePath],
      ref,
      role,
    },
  ];
}

function selectProjectContextDetailFiles(
  envelopes: readonly ProjectContextEnvelope<ProjectContextResult>[],
  limit: number
): string[] {
  const fromModules = envelopes.flatMap((envelope) =>
    isModuleContext(envelope.data) ? envelope.data.ownedFiles.map((file) => file.filePath) : []
  );
  const fromRefs = envelopes.flatMap((envelope) =>
    envelope.refs.flatMap((ref) => (ref.scope.filePath ? [ref.scope.filePath] : []))
  );
  return dedupeStrings([...fromModules, ...fromRefs])
    .filter((filePath) => !filePath.endsWith('/'))
    .slice(0, limit);
}

function resolveProjectContextDimensions(_primaryLang: string): DimensionDef[] {
  return [...baseDimensions];
}

function inferProjectContextPrimaryLanguage(input: ProjectContextPresenterInput): string {
  const languages = input.repo?.languages ?? [];
  return (
    [...languages].sort((left, right) => (right.fileCount ?? 0) - (left.fileCount ?? 0))[0]
      ?.language ?? 'unknown'
  );
}

function inferProjectContextSecondaryLanguages(
  input: ProjectContextPresenterInput,
  primaryLang: string
): string[] {
  return (input.repo?.languages ?? [])
    .map((language) => language.language)
    .filter((language) => language !== primaryLang)
    .sort();
}

function inferProjectContextProjectType(input: ProjectContextPresenterInput): string {
  return (
    input.repo?.packageSystems[0]?.kind ??
    input.repo?.buildSystems[0]?.kind ??
    input.repo?.repo.name ??
    'project-context'
  );
}

function countRepoLanguageFiles(repo: RepoContext | undefined): number {
  return (repo?.languages ?? []).reduce((sum, language) => sum + (language.fileCount ?? 0), 0);
}

function hasUsableSeedScope(seed: ProjectContextModuleSeed): boolean {
  return Boolean(seed.ownedFiles?.length || normalizeModulePath(seed.modulePath));
}

function seedMatchesRequestedScope(
  seed: ProjectContextModuleSeed,
  requestedScope: ReadonlySet<string>
): boolean {
  const paths = [
    normalizeModulePath(seed.modulePath),
    ...(seed.ownedFiles ?? []).map(normalizeModulePath),
  ].filter(isPresent);
  return paths.some((pathValue) =>
    [...requestedScope].some(
      (scope) =>
        pathValue === scope ||
        pathValue.startsWith(`${scope}/`) ||
        scope.startsWith(`${pathValue}/`)
    )
  );
}

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeModulePath(value: string | undefined): string | undefined {
  return normalizeProjectContextPath(value);
}

function inferModulePathFromProjectContextRef(filePath: string): string | undefined {
  const normalized = normalizeModulePath(filePath);
  if (!normalized) {
    return undefined;
  }
  const parts = normalized.split('/');
  if (parts[0] === 'Packages' && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (normalized.endsWith('/Package.swift')) {
    return parentPath(normalized);
  }
  return normalized.includes('.') ? parentPath(normalized) : normalized;
}

function parentPath(value: string): string | undefined {
  const index = value.lastIndexOf('/');
  return index > 0 ? value.slice(0, index) : undefined;
}

function moduleNameFromPath(pathValue: string, fallback: string): string {
  return (
    pathValue
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.replace(/\.[^.]+$/, '') || fallback
  );
}

function dedupeModuleSeeds(seeds: readonly ProjectContextModuleSeed[]): ProjectContextModuleSeed[] {
  const byKey = new Map<string, ProjectContextModuleSeed>();
  for (const seed of seeds) {
    const key = `${seed.modulePath ?? seed.ownedFiles?.join(',') ?? ''}:${seed.moduleName}`;
    if (!byKey.has(key)) {
      byKey.set(key, seed);
    }
  }
  return [...byKey.values()];
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function uniqueRequestKinds(
  values: readonly ProjectContextRequestKind[]
): ProjectContextRequestKind[] {
  return [...new Set(values)];
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function isRepoContext(value: ProjectContextResult): value is RepoContext {
  return 'repo' in value && 'targets' in value && 'sourceRoots' in value;
}

function isModuleContext(value: ProjectContextResult): value is ModuleContext {
  return 'module' in value && 'ownedFiles' in value && 'publicSurfaces' in value;
}

export function isSpaceContext(value: ProjectContextResult): value is SpaceContext {
  return 'space' in value && 'sourceFolders' in value;
}

export function isProjectMapContext(value: ProjectContextResult): value is ProjectMap {
  return 'modules' in value && 'dependencySummary' in value && 'majorFlows' in value;
}
