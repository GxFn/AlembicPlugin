import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { getPackageVersion, PACKAGE_ROOT } from '../../shared/package-assets.js';
import { CODEX_PLUGIN_ROOT_ENV, CODEX_SETUP_PROFILE } from './RuntimeContext.js';

export type ProjectRootSource =
  | 'explicit-option'
  | 'CODEX_WORKSPACE_DIR'
  | 'CODEX_WORKSPACE_ROOT'
  | 'CLAUDE_PROJECT_DIR'
  | 'INIT_CWD'
  | 'PWD'
  | 'process.cwd';

export type ProjectRootTrust = 'fallback' | 'rejected' | 'trusted';

export interface ProjectRootCandidate {
  path: string;
  source: ProjectRootSource;
  trust: Exclude<ProjectRootTrust, 'rejected'>;
}

export interface ProjectRootResolution {
  candidates: ProjectRootCandidate[];
  path: string | null;
  reason: string;
  rejected: boolean;
  source: ProjectRootSource | null;
  trust: ProjectRootTrust;
}

export interface InitMarker {
  dataRoot: string;
  ghost: boolean;
  initializedAt: string;
  initializedBy: 'alembic_init' | 'codex-plugin-init-on-demand';
  pluginVersion: string;
  profile: typeof CODEX_SETUP_PROFILE;
  projectRoot: string;
  requestedTool?: string;
  results: Array<Record<string, unknown>>;
  route: 'explicit' | 'tool-call';
  schemaVersion: 1;
}

export interface ResolveProjectRootOptions {
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
}

const PROJECT_ROOT_REQUIRED_ACTIONS = [
  'Provide the target project root as an absolute path.',
  'Pass the current workspace directory as the projectRoot argument on the Alembic tool call.',
  'Rerun the Alembic tool after the project root is available.',
];

export function resolveProjectRootFromEnv(
  options: ResolveProjectRootOptions = {}
): ProjectRootResolution {
  const env = options.env || process.env;
  const candidates = buildProjectRootCandidates(options.projectRoot, env);
  if (candidates.length === 0) {
    return {
      candidates,
      path: null,
      reason:
        'No project root candidate was provided by Alembic or Codex. Alembic project workflows require an explicit absolute project root.',
      rejected: true,
      source: null,
      trust: 'rejected',
    };
  }

  const first = candidates[0];
  const rejection = getProjectRootRejectionReason(first.path, env);
  if (rejection) {
    return {
      candidates,
      path: first.path,
      reason: rejection,
      rejected: true,
      source: first.source,
      trust: 'rejected',
    };
  }

  if (first.trust === 'trusted') {
    return {
      candidates,
      path: first.path,
      reason: `Project root is trusted from ${first.source}.`,
      rejected: false,
      source: first.source,
      trust: 'trusted',
    };
  }

  return {
    candidates,
    path: first.path,
    reason: `Project root came from fallback ${first.source}; Alembic cannot treat it as the target project directory. Pass the current workspace directory as an explicit projectRoot.`,
    rejected: false,
    source: first.source,
    trust: 'fallback',
  };
}

export function buildProjectRootRequiredMessage(resolution: ProjectRootResolution): string {
  const candidate = resolution.path
    ? ` Current candidate from ${resolution.source || 'unknown'} was: ${resolution.path}.`
    : '';
  return `Alembic Codex cannot determine the target project directory, so project workflows cannot be used yet. Pass the current workspace directory as an absolute projectRoot argument.${candidate} Reason: ${resolution.reason}`;
}

export function buildProjectRootRequiredActions(): string[] {
  return [...PROJECT_ROOT_REQUIRED_ACTIONS];
}

export function isTrustedProjectRoot(resolution: ProjectRootResolution): boolean {
  return Boolean(resolution.path) && resolution.trust === 'trusted' && !resolution.rejected;
}

export function summarizeProjectRootResolution(
  resolution: ProjectRootResolution
): Record<string, unknown> {
  return {
    path: resolution.path,
    source: resolution.source,
    trust: resolution.trust,
    rejected: resolution.rejected,
    reason: resolution.reason,
    userMessage:
      resolution.trust === 'trusted' ? null : buildProjectRootRequiredMessage(resolution),
    requiredActions: resolution.trust === 'trusted' ? [] : buildProjectRootRequiredActions(),
    candidates: resolution.candidates.map((candidate) => ({
      source: candidate.source,
      trust: candidate.trust,
      path: candidate.path,
    })),
  };
}

export function getInitMarkerPath(runtimeDir: string): string {
  return resolve(runtimeDir, 'codex-init.json');
}

export function readInitMarker(runtimeDir: string): InitMarker | null {
  let markerPath: string;
  try {
    markerPath = getInitMarkerPath(runtimeDir);
  } catch {
    return null;
  }
  if (!existsSync(markerPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<InitMarker>;
    return isInitMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeInitMarker(
  location: { projectRoot: string; dataRoot: string; runtimeDir: string; ghost: boolean },
  input: Omit<
    InitMarker,
    | 'dataRoot'
    | 'ghost'
    | 'initializedAt'
    | 'pluginVersion'
    | 'profile'
    | 'projectRoot'
    | 'schemaVersion'
  >
): InitMarker {
  const marker: InitMarker = {
    schemaVersion: 1,
    initializedAt: new Date().toISOString(),
    initializedBy: input.initializedBy,
    route: input.route,
    projectRoot: location.projectRoot,
    dataRoot: location.dataRoot,
    profile: CODEX_SETUP_PROFILE,
    ghost: location.ghost,
    pluginVersion: getPackageVersion(),
    results: input.results,
    ...(input.requestedTool ? { requestedTool: input.requestedTool } : {}),
  };
  const markerPath = getInitMarkerPath(location.runtimeDir);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return marker;
}

function buildProjectRootCandidates(
  projectRoot: string | undefined,
  env: NodeJS.ProcessEnv
): ProjectRootCandidate[] {
  const candidates: ProjectRootCandidate[] = [];
  pushCandidate(candidates, projectRoot, 'explicit-option', 'trusted', env);
  pushCandidate(candidates, env.CODEX_WORKSPACE_DIR, 'CODEX_WORKSPACE_DIR', 'trusted', env);
  pushCandidate(candidates, env.CODEX_WORKSPACE_ROOT, 'CODEX_WORKSPACE_ROOT', 'trusted', env);
  // DH-3①: claude-code 工作区根（Claude Code 设置 CLAUDE_PROJECT_DIR）纳入可信候选，使 cc
  // 工作区不再 fail-closed（codex 不设此 env，故 codex 行为不变）。仅多一个 host-agnostic 的
  // 可信 env 源，按现有 trust/拒绝校验同等处理；host 选择分支只在 L3 resolveHostAdapter。
  pushCandidate(candidates, env.CLAUDE_PROJECT_DIR, 'CLAUDE_PROJECT_DIR', 'trusted', env);
  pushCandidate(candidates, env.INIT_CWD, 'INIT_CWD', 'trusted', env);
  pushCandidate(candidates, env.PWD, 'PWD', 'trusted', env);
  pushCandidate(candidates, safeProcessCwd(), 'process.cwd', 'trusted', env);
  return candidates;
}

function pushCandidate(
  candidates: ProjectRootCandidate[],
  rawPath: string | undefined,
  source: ProjectRootSource,
  trust: Exclude<ProjectRootTrust, 'rejected'>,
  env: NodeJS.ProcessEnv
): void {
  const resolved = resolveCandidatePath(rawPath, env);
  if (!resolved) {
    return;
  }
  if (candidates.some((candidate) => candidate.path === resolved)) {
    return;
  }
  candidates.push({ path: resolved, source, trust });
}

function resolveCandidatePath(rawPath: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const trimmed = rawPath?.trim();
  if (!trimmed) {
    return null;
  }
  if (isAbsolute(trimmed)) {
    return resolve(trimmed);
  }
  const base = safeProcessCwd() || absoluteEnvPath(env.PWD) || homedir();
  return resolve(base, trimmed);
}

function getProjectRootRejectionReason(path: string, env: NodeJS.ProcessEnv): string | null {
  if (!existsSync(path)) {
    return `Project root does not exist: ${path}`;
  }
  if (!safeIsDirectory(path)) {
    return `Project root is not a directory: ${path}`;
  }
  if (isFilesystemRoot(path)) {
    return 'Project root points to the filesystem root.';
  }
  if (path === resolve(homedir())) {
    return 'Project root points to the user home directory.';
  }
  if (path === resolve(tmpdir()) || path === '/tmp' || path === '/private/tmp') {
    return 'Project root points to a temporary root directory.';
  }
  if (isCodexPluginCachePath(path)) {
    return 'Project root points inside the Codex plugin cache.';
  }
  const pluginRoot = resolveConfiguredPluginRoot(env);
  if (pluginRoot && path === pluginRoot && isCodexPluginCachePath(pluginRoot)) {
    return 'Project root points to the installed Alembic Codex plugin root.';
  }
  const packageRoot = resolve(PACKAGE_ROOT);
  if (path === packageRoot && isCodexPluginCachePath(packageRoot)) {
    return 'Project root points to the Alembic runtime package root.';
  }
  return null;
}

function resolveConfiguredPluginRoot(env: NodeJS.ProcessEnv): string | null {
  return resolveCandidatePath(env[CODEX_PLUGIN_ROOT_ENV], env);
}

function isCodexPluginCachePath(path: string): boolean {
  const normalized = path.split('/').join(sep);
  const marker = `${sep}.codex${sep}plugins${sep}cache${sep}`;
  return normalized.includes(marker);
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFilesystemRoot(path: string): boolean {
  return dirname(path) === path;
}

function safeProcessCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

function absoluteEnvPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  return trimmed && isAbsolute(trimmed) ? trimmed : undefined;
}

function isInitMarker(value: Partial<InitMarker>): value is InitMarker {
  return (
    value.schemaVersion === 1 &&
    typeof value.initializedAt === 'string' &&
    (value.initializedBy === 'alembic_init' ||
      value.initializedBy === 'codex-plugin-init-on-demand') &&
    (value.route === 'explicit' || value.route === 'tool-call') &&
    typeof value.projectRoot === 'string' &&
    typeof value.dataRoot === 'string' &&
    value.profile === CODEX_SETUP_PROFILE &&
    typeof value.ghost === 'boolean' &&
    typeof value.pluginVersion === 'string' &&
    Array.isArray(value.results)
  );
}
