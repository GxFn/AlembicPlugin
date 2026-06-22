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

interface BuildHostAgentProjectContextAnalysisInput {
  projectRoot: string;
  source: 'codex-host-bootstrap' | 'codex-host-rescan';
  moduleScope?: readonly string[];
  maxFiles?: unknown;
  maxModuleSeeds?: number;
  maxModuleDetails?: number;
  maxFileDetails?: number;
}

interface ProjectContextModuleSeed {
  configLayer?: string;
  kind?: string;
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

export async function buildHostAgentProjectContextAnalysis(
  input: BuildHostAgentProjectContextAnalysisInput
): Promise<HostAgentProjectContextAnalysis> {
  const maxModuleSeeds = input.maxModuleSeeds ?? 6;
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
  const moduleSeeds = selectProjectContextModuleSeeds(repoData, maxModuleSeeds, input.moduleScope);
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
  return {
    dimensions,
    envelopes,
    fileCount: presenterInput.files.length,
    isEmpty: presenterInput.files.length === 0 && presenterInput.refs.length === 0,
    isMultiLang: secondaryLanguages.length > 0,
    moduleCount: presenterInput.modules.length || presenterInput.map?.modules.length || 0,
    moduleSeeds,
    presenterInput,
    primaryLang,
    projectType: inferProjectContextProjectType(presenterInput),
    requestKinds: uniqueRequestKinds(envelopes.map((envelope) => envelope.queryLevel)),
    secondaryLanguages,
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

function selectProjectContextModuleSeeds(
  repo: RepoContext | undefined,
  limit: number,
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
  return dedupeModuleSeeds(scopedCandidates).slice(0, limit);
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
  return [
    {
      kind: 'file-anchor',
      moduleName: moduleNameFromPath(filePath, moduleName),
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
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '.') {
    return undefined;
  }
  return trimmed.replace(/\\/g, '/').replace(/\/$/, '');
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
