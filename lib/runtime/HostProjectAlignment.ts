import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createProjectRuntimeControlState,
  PROJECT_RUNTIME_CONTROL_STATE_SCHEMA_VERSION,
  type ProjectRuntimeControlState,
} from '@alembic/core/daemon';
import {
  getProjectRegistryDir,
  normalizeProjectPath,
  ProjectRegistry,
  type ProjectRegistryInspection,
} from '@alembic/core/workspace';
import type { DaemonStatus } from '../daemon/DaemonSupervisor.js';
import type { CodexEnhancementRouteChoice } from '../runtime/EnhancementRoute.js';
import type { AlembicResidentProjectScopeIdentity } from '../service/resident/AlembicResidentServiceClient.js';

export type CodexHostProjectConnectionState =
  | 'connected'
  | 'mismatch'
  | 'disconnected'
  | 'unavailable';

export type CodexHostProjectAlignmentSource =
  | 'codex-host'
  | 'daemon-state'
  | 'project-registry'
  | 'resident-service-scope'
  | 'runtime-control-state';

export interface CodexAlignedProjectSummary {
  dataRoot: string | null;
  dataRootSource: string | null;
  ghost: boolean | null;
  projectId: string | null;
  projectRealpath: string | null;
  projectRoot: string | null;
  registered: boolean | null;
  source: CodexHostProjectAlignmentSource;
}

export interface CodexHandoffMismatch {
  activeRoot: string | null;
  hostRoot: string | null;
  reason:
    | 'active-runtime-project-differs'
    | 'active-runtime-unavailable'
    | 'host-project-unavailable'
    | 'runtime-control-unavailable'
    | 'selected-project-differs';
  selectedRoot: string | null;
}

export interface CodexRuntimeControlStateSummary {
  exists: boolean;
  path: string;
  readable: boolean;
  schemaVersion: number | null;
  selectedAt: string | null;
  source: 'missing' | 'readable' | 'unreadable' | 'unsupported-schema';
  updatedAt: string | null;
}

export interface CodexHostProjectAlignment {
  activeRuntimeProject: CodexAlignedProjectSummary | null;
  connectionState: CodexHostProjectConnectionState;
  handoffAllowed: boolean;
  handoffMismatch: CodexHandoffMismatch | null;
  hostProject: CodexAlignedProjectSummary;
  nextActions: string[];
  runtimeControlState: CodexRuntimeControlStateSummary;
  selectedProject: CodexAlignedProjectSummary | null;
  sources: {
    daemonRuntimeBoundary: boolean;
    daemonState: boolean;
    projectRegistry: boolean;
    projectsApi: false;
    residentServiceScope: boolean;
    runtimeControlState: boolean;
  };
}

interface RuntimeControlReadResult {
  state: ProjectRuntimeControlState;
  summary: CodexRuntimeControlStateSummary;
}

export function buildCodexHostProjectAlignment(input: {
  daemonStatus: DaemonStatus;
  enhancementRoute?: CodexEnhancementRouteChoice | null;
  projectScopeIdentity?: AlembicResidentProjectScopeIdentity | null;
  projectRoot: string;
}): CodexHostProjectAlignment {
  const hostProject = projectFromRoot(input.projectRoot, 'codex-host');
  const runtimeControl = readProjectRuntimeControlState();
  const selectedProject = projectFromRuntimeControlTarget(
    runtimeControl.state.selectedProjectRoot,
    runtimeControl.state.selectedProjectId,
    'runtime-control-state'
  );
  const residentServiceProject = projectFromResidentServiceScope(input.enhancementRoute);
  const activeRuntimeProject =
    projectFromRuntimeControlTarget(
      runtimeControl.state.activeProjectRoot,
      runtimeControl.state.activeProjectId,
      'runtime-control-state'
    ) ||
    residentServiceProject ||
    projectFromDaemonState(input.daemonStatus);

  const hostRoot = hostProject.projectRealpath || hostProject.projectRoot;
  const selectedRoot = selectedProject?.projectRealpath || selectedProject?.projectRoot || null;
  const activeRoot =
    activeRuntimeProject?.projectRealpath || activeRuntimeProject?.projectRoot || null;
  const selectedDiffers = Boolean(
    selectedRoot &&
      !sameProjectRoot(hostRoot, selectedRoot) &&
      !sameProjectScopeRoot(input.projectScopeIdentity, hostRoot, selectedRoot)
  );
  const activeDiffers = Boolean(
    activeRoot &&
      !sameProjectRoot(hostRoot, activeRoot) &&
      !sameProjectScopeRoot(input.projectScopeIdentity, hostRoot, activeRoot)
  );
  const connectionState = resolveConnectionState({
    activeDiffers,
    activeRoot,
    daemonReady: input.daemonStatus.ready === true,
    hostRoot,
    projectScopeResidentReady: isProjectScopeResidentReady(input.projectScopeIdentity),
    runtimeControl: runtimeControl.summary,
    selectedDiffers,
    selectedRoot,
  });
  const handoffMismatch = buildHandoffMismatch({
    activeDiffers,
    activeRoot,
    connectionState,
    hostRoot,
    runtimeControl: runtimeControl.summary,
    selectedDiffers,
    selectedRoot,
  });

  return {
    activeRuntimeProject,
    connectionState,
    handoffAllowed: connectionState === 'connected',
    handoffMismatch,
    hostProject,
    nextActions: buildAlignmentNextActions(connectionState),
    runtimeControlState: runtimeControl.summary,
    selectedProject,
    sources: {
      daemonRuntimeBoundary: false,
      daemonState: input.daemonStatus.ready === true && Boolean(input.daemonStatus.state),
      projectRegistry: hostProject.registered === true,
      projectsApi: false,
      residentServiceScope: Boolean(residentServiceProject),
      runtimeControlState: runtimeControl.summary.source === 'readable',
    },
  };
}

export function getCodexProjectRuntimeControlStatePath(): string {
  return join(getProjectRegistryDir(), 'runtime-control.json');
}

function readProjectRuntimeControlState(): RuntimeControlReadResult {
  const path = getCodexProjectRuntimeControlStatePath();
  const exists = existsSync(path);
  if (!exists) {
    return {
      state: createProjectRuntimeControlState(),
      summary: {
        exists: false,
        path,
        readable: false,
        schemaVersion: null,
        selectedAt: null,
        source: 'missing',
        updatedAt: null,
      },
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProjectRuntimeControlState>;
    const schemaVersion = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : null;
    if (schemaVersion !== PROJECT_RUNTIME_CONTROL_STATE_SCHEMA_VERSION) {
      return {
        state: createProjectRuntimeControlState(),
        summary: {
          exists: true,
          path,
          readable: true,
          schemaVersion,
          selectedAt: nullableString(parsed.selectedAt),
          source: 'unsupported-schema',
          updatedAt: nullableString(parsed.updatedAt),
        },
      };
    }
    const state = createProjectRuntimeControlState({
      activeProjectId: nullableString(parsed.activeProjectId),
      activeProjectRoot: nullableString(parsed.activeProjectRoot),
      selectedAt: nullableString(parsed.selectedAt),
      selectedProjectId: nullableString(parsed.selectedProjectId),
      selectedProjectRoot: nullableString(parsed.selectedProjectRoot),
      updatedAt: nullableString(parsed.updatedAt) ?? new Date(0).toISOString(),
    });
    return {
      state,
      summary: {
        exists: true,
        path,
        readable: true,
        schemaVersion,
        selectedAt: state.selectedAt,
        source: 'readable',
        updatedAt: state.updatedAt,
      },
    };
  } catch {
    return {
      state: createProjectRuntimeControlState(),
      summary: {
        exists: true,
        path,
        readable: false,
        schemaVersion: null,
        selectedAt: null,
        source: 'unreadable',
        updatedAt: null,
      },
    };
  }
}

function resolveConnectionState(input: {
  activeDiffers: boolean;
  activeRoot: string | null;
  daemonReady: boolean;
  hostRoot: string | null;
  projectScopeResidentReady: boolean;
  runtimeControl: CodexRuntimeControlStateSummary;
  selectedDiffers: boolean;
  selectedRoot: string | null;
}): CodexHostProjectConnectionState {
  if (!input.hostRoot) {
    return 'unavailable';
  }
  if (input.selectedDiffers || input.activeDiffers) {
    return 'mismatch';
  }
  if (input.projectScopeResidentReady) {
    return 'connected';
  }
  if (input.daemonReady && (input.activeRoot || input.runtimeControl.source !== 'readable')) {
    return 'connected';
  }
  if (input.selectedRoot || input.activeRoot) {
    return 'disconnected';
  }
  return 'unavailable';
}

function buildHandoffMismatch(input: {
  activeDiffers: boolean;
  activeRoot: string | null;
  connectionState: CodexHostProjectConnectionState;
  hostRoot: string | null;
  runtimeControl: CodexRuntimeControlStateSummary;
  selectedDiffers: boolean;
  selectedRoot: string | null;
}): CodexHandoffMismatch | null {
  if (input.connectionState === 'connected') {
    return null;
  }
  if (!input.hostRoot) {
    return {
      activeRoot: input.activeRoot,
      hostRoot: input.hostRoot,
      reason: 'host-project-unavailable',
      selectedRoot: input.selectedRoot,
    };
  }
  if (input.selectedDiffers) {
    return {
      activeRoot: input.activeRoot,
      hostRoot: input.hostRoot,
      reason: 'selected-project-differs',
      selectedRoot: input.selectedRoot,
    };
  }
  if (input.activeDiffers) {
    return {
      activeRoot: input.activeRoot,
      hostRoot: input.hostRoot,
      reason: 'active-runtime-project-differs',
      selectedRoot: input.selectedRoot,
    };
  }
  return {
    activeRoot: input.activeRoot,
    hostRoot: input.hostRoot,
    reason:
      input.runtimeControl.source === 'missing'
        ? 'runtime-control-unavailable'
        : 'active-runtime-unavailable',
    selectedRoot: input.selectedRoot,
  };
}

function buildAlignmentNextActions(state: CodexHostProjectConnectionState): string[] {
  if (state === 'connected') {
    return ['Codex host project is aligned with the Alembic selected and active runtime project.'];
  }
  if (state === 'mismatch') {
    return [
      'Switch Alembic selected/active project to this Codex host project from Alembic or Dashboard before opening Dashboard through Codex.',
      'Run alembic_status again after the Alembic project selection changes.',
    ];
  }
  if (state === 'disconnected') {
    return [
      'Start or reconnect the Alembic runtime for this selected project from Alembic or Dashboard before Dashboard handoff through Codex.',
      'Run alembic_status again after the active runtime is ready.',
    ];
  }
  return ['Select and start this project from Alembic or Dashboard, then rerun alembic_status.'];
}

function projectFromResidentServiceScope(
  enhancementRoute?: CodexEnhancementRouteChoice | null
): CodexAlignedProjectSummary | null {
  const status = enhancementRoute?.localAlembic.daemon.residentService?.status;
  if (!status || status.route !== 'local-alembic-daemon' || status.owner !== 'alembic') {
    return null;
  }
  const scope = status.serviceScope;
  const projectRoot = scope.diagnosticPaths.projectRoot;
  if (!projectRoot) {
    return null;
  }
  // serviceScope 是 Alembic resident service 的当前覆盖范围摘要；这里仅用于只读 handoff
  // 比对，不提供 project list / switch / start / stop 能力。
  return projectFromRoot(projectRoot, 'resident-service-scope', {
    dataRoot: scope.diagnosticPaths.dataRoot,
    dataRootSource: scope.projectIdentity.dataRootSource,
    projectId: scope.projectIdentity.projectId,
  });
}

function projectFromDaemonState(status: DaemonStatus): CodexAlignedProjectSummary | null {
  if (!status.ready || !status.state?.projectRoot) {
    return null;
  }
  return projectFromRoot(status.state.projectRoot, 'daemon-state', {
    dataRoot: status.state.dataRoot,
    dataRootSource: null,
    projectId: status.state.projectId,
  });
}

function projectFromRuntimeControlTarget(
  projectRoot: string | null,
  projectId: string | null,
  source: CodexHostProjectAlignmentSource
): CodexAlignedProjectSummary | null {
  const root = projectRoot || findRegisteredProjectRootById(projectId);
  if (!root) {
    return null;
  }
  return projectFromRoot(root, source, { projectId });
}

function projectFromRoot(
  projectRootInput: string,
  source: CodexHostProjectAlignmentSource,
  overrides: {
    dataRoot?: string | null;
    dataRootSource?: string | null;
    projectId?: string | null;
  } = {}
): CodexAlignedProjectSummary {
  const fallbackRoot = resolve(projectRootInput);
  let inspection: ProjectRegistryInspection | null = null;
  try {
    inspection = ProjectRegistry.inspect(projectRootInput);
  } catch {
    inspection = null;
  }
  return {
    dataRoot: overrides.dataRoot ?? inspection?.dataRoot ?? null,
    dataRootSource: overrides.dataRootSource ?? inspection?.dataRootSource ?? null,
    ghost: inspection?.ghost ?? null,
    projectId: overrides.projectId ?? inspection?.projectId ?? null,
    projectRealpath: inspection?.projectRealpath ?? safeNormalizeProjectPath(fallbackRoot),
    projectRoot: inspection?.projectRoot ?? fallbackRoot,
    registered: inspection?.registered ?? null,
    source,
  };
}

function findRegisteredProjectRootById(projectId: string | null): string | null {
  if (!projectId) {
    return null;
  }
  try {
    return (
      ProjectRegistry.list().find((project) => project.entry.id === projectId)?.projectRoot ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Local-selection awareness for host-local workflows (MT1 P3-3 no-bypass
 * rule): alembic_bootstrap / alembic_rescan operate only on the host
 * project's own data root and therefore proceed under a global selection
 * mismatch, but they must consult and surface the same alignment fact the
 * codex_* gate blocks on instead of silently ignoring it. Root comparison
 * is realpath-based only (no daemon project-scope identity available on
 * this path), so the warning is informational, never blocking.
 */
export function buildCodexLocalSelectionMismatch(projectRoot: string): {
  activeProjectRoot: string | null;
  hostProjectRoot: string;
  note: string;
  selectedProjectRoot: string | null;
} | null {
  const runtimeControl = readProjectRuntimeControlState();
  if (runtimeControl.summary.source !== 'readable') {
    return null;
  }
  const hostRoot = safeNormalizeProjectPath(projectRoot);
  const selectedRoot = runtimeControl.state.selectedProjectRoot;
  const activeRoot = runtimeControl.state.activeProjectRoot;
  const selectedDiffers = Boolean(selectedRoot && !sameProjectRoot(hostRoot, selectedRoot));
  const activeDiffers = Boolean(activeRoot && !sameProjectRoot(hostRoot, activeRoot));
  if (!selectedDiffers && !activeDiffers) {
    return null;
  }
  return {
    activeProjectRoot: activeDiffers ? activeRoot : null,
    hostProjectRoot: projectRoot,
    note: 'The global Alembic runtime selection points at a different project. This operation affected ONLY the Codex host project; the shared Alembic runtime selection was not read, started, or changed.',
    selectedProjectRoot: selectedDiffers ? selectedRoot : null,
  };
}

function sameProjectRoot(left: string | null, right: string | null): boolean {
  if (!left || !right) {
    return false;
  }
  return safeNormalizeProjectPath(left) === safeNormalizeProjectPath(right);
}

function sameProjectScopeRoot(
  identity: AlembicResidentProjectScopeIdentity | null | undefined,
  hostRoot: string | null,
  candidateRoot: string | null
): boolean {
  if (!identity?.available || !hostRoot || !candidateRoot) {
    return false;
  }
  const host = safeNormalizeProjectPath(hostRoot);
  const candidate = safeNormalizeProjectPath(candidateRoot);
  const scopeRoots = [
    identity.controlRoot,
    identity.currentFolderPath,
    ...identity.folders.flatMap((folder) => [folder.path, folder.realpath ?? null]),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => safeNormalizeProjectPath(value));
  return scopeRoots.includes(host) && scopeRoots.includes(candidate);
}

function isProjectScopeResidentReady(
  identity: AlembicResidentProjectScopeIdentity | null | undefined
): boolean {
  return (
    identity?.available === true &&
    identity.mode === 'project-scope' &&
    identity.resident.owner === 'alembic' &&
    identity.resident.route === 'local-alembic-daemon'
  );
}

function safeNormalizeProjectPath(projectRoot: string): string {
  try {
    return normalizeProjectPath(projectRoot);
  } catch {
    return resolve(projectRoot);
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
