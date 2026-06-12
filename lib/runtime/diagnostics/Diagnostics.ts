import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlembicResidentServiceProbe } from '@alembic/core/daemon';
import type { DaemonStatus } from '../../daemon/DaemonSupervisor.js';
import {
  buildCodexEnhancementRouteChoice,
  type CodexEnhancementRouteChoice,
} from '../../runtime/EnhancementRoute.js';
import type { CodexHostProjectAlignment } from '../../runtime/HostProjectAlignment.js';
import {
  buildCodexModuleBoundaryStatus,
  type CodexModuleBoundaryStatus,
} from '../../runtime/ModuleBoundary.js';
import {
  asString,
  CODEX_REQUIRED_SKILLS,
  loadCodexPluginRegistry,
} from '../../runtime/PluginRegistry.js';
import {
  buildCodexProjectRootRequiredMessage,
  type CodexProjectRootResolution,
  summarizeCodexProjectRootResolution,
} from '../../runtime/ProjectRootResolver.js';
import type { CodexProjectRuntimeContext } from '../../runtime/runtime/ProjectRuntimeContext.js';
import {
  ALEMBIC_PLUGIN_HOST_ENV,
  ALEMBIC_RUNTIME_MODE_ENV,
  ALEMBIC_RUNTIME_MODE_PLUGIN,
  CODEX_ADMIN_ENABLE_ENV,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MARKETPLACE_SHELL_ENTRY,
  CODEX_MCP_MODE_ENV,
  CODEX_MCP_SHIM_ENV,
  CODEX_PLUGIN_HOST,
  CODEX_PLUGIN_NAME,
  type CodexRuntimeContext,
  resolveCodexRuntimeContext,
} from '../../runtime/runtime/RuntimeContext.js';
import type { GitDiffCheckpointStatus } from '../../service/evolution/git-diff-checkpoint/index.js';
import type { AlembicResidentProjectScopeIdentity } from '../../service/resident/AlembicResidentServiceClient.js';

export interface CodexPluginDiagnostics {
  assets: { missing: string[]; ok: boolean; required: string[] };
  manifest: { ok: boolean; path: string; version: string | null };
  mcp: {
    adminDisabledByDefault: boolean;
    agentTierByDefault: boolean;
    binary: string | null;
    codexShimMode: boolean;
    command: string | null;
    embeddedRuntime: boolean;
    mcpMode: boolean;
    ok: boolean;
    packagePin: boolean;
    path: string;
    pluginHost: boolean;
    pluginHostValue: string | null;
    pinnedSpecifier: string | null;
    runtimeMode: boolean;
    runtimeModeValue: string | null;
    runtimeSpecifier: string | null;
    entry: CodexMcpEntryDiagnostics;
    wrapper: {
      exists: boolean;
      path: string | null;
      startupLock: boolean;
      startupLockDiagnostics: CodexWrapperStartupLockDiagnostics;
    };
  };
  ok: boolean;
  readme: {
    mentionsEmbeddedRuntime: boolean;
    mentionsPinnedRuntime: boolean;
    ok: boolean;
    path: string;
  };
  root: string;
  skills: { missing: string[]; ok: boolean; required: string[] };
}

export interface CodexMcpEntryDiagnostics {
  args: string[];
  cacheMarker: {
    canonicalLocalDevCommand: string | null;
    entryMode: string | null;
    exists: boolean;
    gitHead: string | null;
    localMcpEntry: string | null;
    mode: string | null;
    packageVersion: string | null;
    pluginVersion: string | null;
    refreshedAt: string | null;
  };
  command: string | null;
  localDistEntry: {
    exists: boolean | null;
    path: string | null;
  };
  mode: 'local-dev-direct-dist' | 'marketplace-shell' | 'stale-installed-cache' | 'unknown';
  nextAction: string;
  runtimeTarball: {
    exists: boolean;
    path: string;
  };
  source:
    | 'installed-refresh-marker'
    | 'plugin-mcp-config'
    | 'plugin-mcp-config+installed-refresh-marker';
  staleReasons: string[];
  wrapperPath: string | null;
}

export interface CodexWrapperStartupLockDiagnostics {
  cacheParentCreation: boolean;
  configured: boolean;
  holdTimeoutEnv: string;
  ownerMetadata: boolean;
  releaseSignals: string[];
  runtimeTarballPreflight: boolean;
  scope: 'plugin-root-runtime-tarball' | 'global-cache-base' | 'missing';
  staleTimeoutEnv: string;
  timeoutEnv: string;
  waitDiagnostics: boolean;
  nextAction: string;
}

export interface CodexRuntimeDiagnosticsOptions {
  autoInit?: Record<string, unknown>;
  commandProbeRunner?: CodexCommandProbeRunner;
  enhancementRoute?: CodexEnhancementRouteChoice;
  hostProjectAlignment?: CodexHostProjectAlignment;
  moduleBoundary?: CodexModuleBoundaryStatus;
  projectRuntime?: CodexProjectRuntimeContext;
  projectScopeIdentity?: AlembicResidentProjectScopeIdentity;
  projectRootResolution?: CodexProjectRootResolution;
  residentService?: AlembicResidentServiceProbe;
}

export interface CodexDiagnosticIssue {
  action: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface CodexCommandProbeResult {
  available: boolean;
  cwd: string | null;
  error: string | null;
  staleCwd: boolean;
  version: string | null;
}

export type CodexCommandProbeRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; encoding: 'utf8'; timeout: number }
) => {
  error?: Error;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
  status: number | null;
};

type CodexMcpConfigMode = 'local-dev-direct-dist' | 'marketplace-shell' | 'unknown';
type CodexPluginRegistry = ReturnType<typeof loadCodexPluginRegistry>;
type CodexRuntimeChecks = Record<string, boolean>;

interface BuildDiagnosticIssuesInput {
  adminEnabled: boolean;
  checks: CodexRuntimeChecks;
  npm: CodexCommandProbeResult;
  npx: CodexCommandProbeResult;
  packageVersion: string;
  pluginHost: string;
  plugin: CodexPluginDiagnostics;
  projectRootResolution?: CodexProjectRootResolution;
  requestedTier: string;
  runtimeMode: string;
}

interface CodexMcpEntryDiagnosticsInput {
  args: string[];
  command: string | null;
  packageVersion: string;
  pluginVersion: string | null;
  registryPluginRoot: string;
  runtimeTarballPath: string;
  wrapperArg: string | null;
  wrapperPath: string | null;
}

export function buildCodexRuntimeDiagnostics(
  daemonStatus: DaemonStatus,
  context: CodexRuntimeContext = resolveCodexRuntimeContext(),
  options: CodexRuntimeDiagnosticsOptions = {}
): Record<string, unknown> {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
  const npm = probeCodexRuntimeCommand('npm', context, options.commandProbeRunner);
  const npx = probeCodexRuntimeCommand('npx', context, options.commandProbeRunner);
  const npmAvailable = npm.available === true;
  const npxAvailable = npx.available === true;
  const plugin = buildCodexPluginDiagnostics(context);
  const enhancementRoute =
    options.enhancementRoute ||
    buildCodexEnhancementRouteChoice({
      daemonStatus,
      runtime: context,
      requirement: 'status',
    });
  const moduleBoundary =
    options.moduleBoundary ||
    buildCodexModuleBoundaryStatus({
      enhancementRoute,
      hostProjectAlignment: options.hostProjectAlignment,
    });
  const checks = buildCodexRuntimeChecks({
    context,
    nodeMajor,
    npmAvailable,
    npxAvailable,
    options,
    plugin,
  });
  const issues = buildDiagnosticIssues({
    adminEnabled: context.adminEnabled,
    checks,
    npm,
    npx,
    packageVersion: context.packageVersion,
    pluginHost: context.pluginHost,
    plugin,
    projectRootResolution: options.projectRootResolution,
    requestedTier: context.requestedTier,
    runtimeMode: context.runtimeMode,
  });

  return {
    ok: Object.values(checks).every(Boolean),
    summary: buildDiagnosticSummary(issues),
    checks,
    issues,
    nextActions: buildDiagnosticNextActions(issues),
    primaryAction:
      issues.length === 0
        ? buildRecommendedAction({
            label: 'Check workspace status',
            reason: 'Runtime checks passed; inspect project initialization and daemon state next.',
            startsDaemon: false,
            tool: 'alembic_codex_status',
          })
        : buildRecommendedAction({
            label: 'Fix diagnostics',
            reason: 'Resolve the reported runtime or plugin metadata issue before using Alembic.',
            startsDaemon: false,
            tool: 'alembic_codex_diagnostics',
          }),
    ...buildCodexRuntimeReportSections({
      checks,
      context,
      daemonStatus,
      enhancementRoute,
      moduleBoundary,
      npm,
      npx,
      options,
      plugin,
    }),
  };
}

function buildCodexRuntimeChecks(input: {
  context: CodexRuntimeContext;
  nodeMajor: number;
  npmAvailable: boolean;
  npxAvailable: boolean;
  options: CodexRuntimeDiagnosticsOptions;
  plugin: CodexPluginDiagnostics;
}): CodexRuntimeChecks {
  return {
    adminGate: input.context.requestedTier !== 'admin' || input.context.adminEnabled,
    node: input.nodeMajor >= 22,
    npm: input.npmAvailable,
    npx: true,
    runtimeMode: input.context.runtimeMode === input.context.expectedRuntimeMode,
    runtimePluginHost: input.context.pluginHost === input.context.expectedPluginHost,
    embeddedRuntime: input.plugin.mcp.embeddedRuntime,
    packagePin: input.plugin.mcp.packagePin,
    pluginHost: input.plugin.mcp.pluginHost,
    pluginRuntimeMode: input.plugin.mcp.runtimeMode,
    pluginAssets: input.plugin.assets.ok,
    pluginManifest: input.plugin.manifest.ok,
    pluginMcp: input.plugin.mcp.ok,
    pluginMcpEntry:
      input.plugin.mcp.entry.mode !== 'unknown' &&
      input.plugin.mcp.entry.mode !== 'stale-installed-cache',
    pluginSkills: input.plugin.skills.ok,
    projectRoot:
      !input.options.projectRootResolution ||
      input.options.projectRootResolution.trust === 'trusted',
    residentServiceContract:
      !input.options.residentService || input.options.residentService.status.contractVersion === 1,
  };
}

function buildCodexRuntimeReportSections(input: {
  checks: CodexRuntimeChecks;
  context: CodexRuntimeContext;
  daemonStatus: DaemonStatus;
  enhancementRoute: CodexEnhancementRouteChoice;
  moduleBoundary: CodexModuleBoundaryStatus;
  npm: CodexCommandProbeResult;
  npx: CodexCommandProbeResult;
  options: CodexRuntimeDiagnosticsOptions;
  plugin: CodexPluginDiagnostics;
}): Record<string, unknown> {
  return {
    node: {
      ok: input.checks.node,
      required: '>=22',
      recommended: '22 LTS',
      version: process.versions.node,
      execPath: process.execPath,
      modules: process.versions.modules,
    },
    commands: {
      npm: input.npm,
      npx: input.npx,
    },
    package: {
      name: input.context.runtimePackage,
      version: input.context.packageVersion,
      embeddedRuntime: input.plugin.mcp.embeddedRuntime,
      runtimeSpecifier: input.context.embeddedRuntimeSpecifier,
      pinnedSpecifier: input.context.pinnedRuntimeSpecifier,
      mcpBinary: input.context.runtimeBin,
    },
    projectRootResolution: input.options.projectRootResolution
      ? summarizeCodexProjectRootResolution(input.options.projectRootResolution)
      : null,
    autoInit: input.options.autoInit || null,
    hostProjectAlignment: input.options.hostProjectAlignment || null,
    enhancementRoute: input.enhancementRoute,
    residentService: input.options.residentService || null,
    residentServiceBoundary: buildResidentServiceBoundary(input.options.residentService),
    projectRuntime: input.options.projectRuntime || null,
    projectScopeIdentity: input.options.projectScopeIdentity || null,
    moduleBoundary: input.moduleBoundary,
    gitDiffCheckpoint: readHealthGitDiffCheckpoint(input.daemonStatus.health),
    plugin: input.plugin,
    daemon: {
      ready: input.daemonStatus.ready,
      status: input.daemonStatus.status,
      stateVersion: input.daemonStatus.state?.version || null,
      healthVersion: readHealthVersion(input.daemonStatus.health),
    },
    codex: {
      channelId: input.context.channelId,
      expectedChannelId: input.context.expectedChannelId,
      pluginHost: input.context.pluginHost,
      runtimeMode: input.context.runtimeMode,
      requestedTier: input.context.requestedTier,
      effectiveTier: input.context.effectiveTier,
      adminEnabled: input.context.adminEnabled,
      adminMode: input.context.adminEnabled
        ? `enabled-by-${CODEX_ADMIN_ENABLE_ENV}`
        : `disabled-requires-${CODEX_ADMIN_ENABLE_ENV}=1`,
    },
    runtimeIdentity: {
      mode: input.context.runtimeMode,
      expectedMode: input.context.expectedRuntimeMode,
      pluginHost: input.context.pluginHost,
      expectedPluginHost: input.context.expectedPluginHost,
      isPluginRuntime: input.context.runtimeMode === ALEMBIC_RUNTIME_MODE_PLUGIN,
      env: {
        mode: ALEMBIC_RUNTIME_MODE_ENV,
        pluginHost: ALEMBIC_PLUGIN_HOST_ENV,
        channelId: 'ALEMBIC_CHANNEL_ID',
      },
    },
    offlineFallback: {
      note: 'The Codex plugin ships a lightweight marketplace shell. The shell installs the exact pinned @gxfn/alembic-runtime package into a startup cache with lock protection, then starts the cached MCP entrypoint with Node.',
      registryPackageFallback: false,
      localPackage: input.context.pinnedRuntimeSpecifier,
      command: input.context.runtimeBin,
    },
    cleanup: {
      automaticOnUninstall: false,
      command: 'alembic_codex_cleanup',
      defaultMode: 'dry-run',
    },
  };
}

export function buildCodexPluginDiagnostics(
  context: CodexRuntimeContext = resolveCodexRuntimeContext()
): CodexPluginDiagnostics {
  const registry = loadCodexPluginRegistry(context);
  const assets = buildCodexPluginAssetDiagnostics(registry);
  const manifest = buildCodexPluginManifestDiagnostics(registry);
  const mcp = buildCodexPluginMcpDiagnostics(context, registry);
  const readme = buildCodexPluginReadmeDiagnostics(context, registry);
  const skills = buildCodexPluginSkillDiagnostics(registry);

  return {
    assets,
    manifest,
    mcp,
    ok: manifest.ok && mcp.ok && assets.ok && skills.ok && readme.ok,
    readme,
    root: registry.plugin.root,
    skills,
  };
}

function buildCodexPluginMcpDiagnostics(
  context: CodexRuntimeContext,
  registry: CodexPluginRegistry
): CodexPluginDiagnostics['mcp'] {
  const args = registry.mcp.args;
  const command =
    typeof registry.mcp.server?.command === 'string' ? registry.mcp.server.command : null;
  const startupArg = args.find((arg) => arg.endsWith('alembic-start.mjs')) || null;
  const startupPath = startupArg
    ? join(registry.plugin.root, startupArg.replace(/^\.\//, ''))
    : null;
  const startupSource =
    startupPath && existsSync(startupPath) ? readFileSync(startupPath, 'utf8') : '';
  const runtimeTarballPath = join(registry.plugin.root, 'runtime.tgz');
  const shellUsesPinnedRuntime = startupSourceUsesPinnedRuntime(startupSource, context);
  const entry = buildCodexMcpEntryDiagnostics({
    args,
    command,
    packageVersion: context.packageVersion,
    pluginVersion: asString(registry.plugin.manifest.value?.version) || null,
    registryPluginRoot: registry.plugin.root,
    runtimeTarballPath,
    wrapperArg: startupArg,
    wrapperPath: startupPath,
  });
  const startupLockDiagnostics = buildWrapperStartupLockDiagnostics(startupSource);
  const localDevRuntime =
    entry.mode === 'local-dev-direct-dist' &&
    entry.localDistEntry.exists === true &&
    !args.includes('latest');
  const binary =
    args.find((arg) => arg === context.runtimeBin) ||
    (shellUsesPinnedRuntime || localDevRuntime ? context.runtimeBin : null);
  const embeddedRuntime =
    command === 'node' &&
    args.includes(CODEX_MARKETPLACE_SHELL_ENTRY) &&
    shellUsesPinnedRuntime &&
    binary === context.runtimeBin &&
    !args.includes('latest');
  const packagePin = embeddedRuntime || localDevRuntime;
  const envDiagnostics = buildCodexPluginMcpEnvDiagnostics(registry);
  const mcpOk =
    packagePin &&
    envDiagnostics.adminDisabledByDefault &&
    envDiagnostics.agentTierByDefault &&
    envDiagnostics.pluginHost &&
    envDiagnostics.runtimeMode &&
    envDiagnostics.mcpMode &&
    envDiagnostics.codexShimMode;

  return {
    adminDisabledByDefault: envDiagnostics.adminDisabledByDefault,
    agentTierByDefault: envDiagnostics.agentTierByDefault,
    binary,
    codexShimMode: envDiagnostics.codexShimMode,
    command,
    embeddedRuntime,
    mcpMode: envDiagnostics.mcpMode,
    ok: mcpOk,
    packagePin,
    path: registry.mcp.json.path,
    pluginHost: envDiagnostics.pluginHost,
    pluginHostValue: envDiagnostics.pluginHostValue,
    pinnedSpecifier: context.pinnedRuntimeSpecifier,
    runtimeMode: envDiagnostics.runtimeMode,
    runtimeModeValue: envDiagnostics.runtimeModeValue,
    runtimeSpecifier: context.pinnedRuntimeSpecifier,
    entry,
    wrapper: {
      exists: Boolean(startupPath && existsSync(startupPath)),
      path: startupPath,
      startupLock: false,
      startupLockDiagnostics,
    },
  };
}

function buildCodexPluginMcpEnvDiagnostics(
  registry: CodexPluginRegistry
): Pick<
  CodexPluginDiagnostics['mcp'],
  | 'adminDisabledByDefault'
  | 'agentTierByDefault'
  | 'codexShimMode'
  | 'mcpMode'
  | 'pluginHost'
  | 'pluginHostValue'
  | 'runtimeMode'
  | 'runtimeModeValue'
> {
  const pluginHostValue = asString(registry.mcp.env?.[ALEMBIC_PLUGIN_HOST_ENV]) || null;
  const runtimeModeValue = asString(registry.mcp.env?.[ALEMBIC_RUNTIME_MODE_ENV]) || null;
  return {
    adminDisabledByDefault: registry.mcp.env?.[CODEX_ADMIN_ENABLE_ENV] === '0',
    agentTierByDefault: registry.mcp.env?.ALEMBIC_MCP_TIER === CODEX_DEFAULT_MCP_TIER,
    codexShimMode: registry.mcp.env?.[CODEX_MCP_SHIM_ENV] === '1',
    mcpMode: registry.mcp.env?.[CODEX_MCP_MODE_ENV] === '1',
    pluginHost: pluginHostValue === CODEX_PLUGIN_HOST,
    pluginHostValue,
    runtimeMode: runtimeModeValue === ALEMBIC_RUNTIME_MODE_PLUGIN,
    runtimeModeValue,
  };
}

function startupSourceUsesPinnedRuntime(
  startupSource: string,
  context: CodexRuntimeContext
): boolean {
  const requiredMarkers = [
    "'npm'",
    "'install'",
    context.pinnedRuntimeSpecifier,
    context.runtimeBin,
    'ALEMBIC_CODEX_RUNTIME_CACHE_DIR',
    'ALEMBIC_CODEX_RUNTIME_OFFLINE',
    'acquireRuntimeLock',
    'ALEMBIC_CODEX_RUNTIME_LOCK_TIMEOUT',
    'ALEMBIC_CODEX_RUNTIME_CACHE_NOT_WRITABLE',
    'ALEMBIC_CODEX_RUNTIME_INSTALL_FAILED',
    'ALEMBIC_CODEX_RUNTIME_VERSION_MISMATCH_AFTER_INSTALL',
    'ALEMBIC_CODEX_RUNTIME_ENTRYPOINT_MISSING',
  ];
  return (
    requiredMarkers.every((marker) => startupSource.includes(marker)) &&
    !startupSource.includes('latest')
  );
}

function buildCodexPluginAssetDiagnostics(
  registry: CodexPluginRegistry
): CodexPluginDiagnostics['assets'] {
  const missingAssets = registry.plugin.assets.filter(
    (asset) => !existsSync(join(registry.plugin.root, asset))
  );
  // Marketplace interface assets are a Codex-shell manifest requirement; the
  // Claude Code spec-form manifest has no interface block, so an empty asset
  // list is the correct healthy state for that host shape (F-V2-2).
  const emptyIsHealthy = registry.plugin.hostShape === 'claude-code';
  return {
    missing: missingAssets,
    ok: (registry.plugin.assets.length > 0 || emptyIsHealthy) && missingAssets.length === 0,
    required: registry.plugin.assets,
  };
}

function buildCodexPluginManifestDiagnostics(
  registry: CodexPluginRegistry
): CodexPluginDiagnostics['manifest'] {
  return {
    ok:
      registry.plugin.manifest.ok &&
      asString(registry.plugin.manifest.value?.name) === CODEX_PLUGIN_NAME,
    path: registry.plugin.manifest.path,
    version: asString(registry.plugin.manifest.value?.version) || null,
  };
}

function buildCodexPluginSkillDiagnostics(
  registry: CodexPluginRegistry
): CodexPluginDiagnostics['skills'] {
  const requiredSkills = [...CODEX_REQUIRED_SKILLS];
  const missingSkills = requiredSkills.filter(
    (skill) => !existsSync(join(registry.plugin.root, 'skills', skill, 'SKILL.md'))
  );
  return {
    missing: missingSkills,
    ok: missingSkills.length === 0,
    required: requiredSkills,
  };
}

function buildCodexPluginReadmeDiagnostics(
  context: CodexRuntimeContext,
  registry: CodexPluginRegistry
): CodexPluginDiagnostics['readme'] {
  const mentionsEmbeddedRuntime = registry.plugin.readme.includes(context.pinnedRuntimeSpecifier);
  const mentionsPinnedRuntime = registry.plugin.readme.includes(context.pinnedRuntimeSpecifier);
  return {
    mentionsEmbeddedRuntime,
    mentionsPinnedRuntime,
    ok: mentionsEmbeddedRuntime && mentionsPinnedRuntime,
    path: registry.plugin.readmePath,
  };
}

function buildCodexMcpEntryDiagnostics(
  input: CodexMcpEntryDiagnosticsInput
): CodexMcpEntryDiagnostics {
  const marker = readInstalledRefreshMarker(
    join(input.registryPluginRoot, '.alembic-dev-refresh.json')
  );
  const localDistArg = findLocalDistArg(input.args);
  const localDistPath = resolveLocalDistEntryPath(input.registryPluginRoot, marker, localDistArg);
  const localDistEntryExists = localDistPath ? existsSync(localDistPath) : null;
  const runtimeTarballExists = existsSync(input.runtimeTarballPath);
  const hasWrapper = Boolean(input.wrapperArg);
  const configMode = resolveCodexMcpConfigMode(localDistArg, hasWrapper);
  const staleReasons = collectCodexMcpEntryStaleReasons({
    configMode,
    hasWrapper,
    input,
    localDistEntryExists,
    localDistPath,
    marker,
    runtimeTarballExists,
  });

  const mode =
    staleReasons.length > 0 && configMode !== 'unknown' ? 'stale-installed-cache' : configMode;

  return {
    args: input.args,
    cacheMarker: marker,
    command: input.command,
    localDistEntry: {
      exists: localDistEntryExists,
      path: localDistPath,
    },
    mode,
    nextAction: entryModeNextAction(mode),
    runtimeTarball: {
      exists: runtimeTarballExists,
      path: input.runtimeTarballPath,
    },
    source: marker.exists ? 'plugin-mcp-config+installed-refresh-marker' : 'plugin-mcp-config',
    staleReasons,
    wrapperPath: input.wrapperPath,
  };
}

function findLocalDistArg(args: string[]): string | null {
  return (
    args.find(
      (arg) => arg.endsWith('/dist/bin/codex-mcp.js') || arg.endsWith('dist/bin/codex-mcp.js')
    ) || null
  );
}

function resolveLocalDistEntryPath(
  registryPluginRoot: string,
  marker: CodexMcpEntryDiagnostics['cacheMarker'],
  localDistArg: string | null
): string | null {
  if (localDistArg) {
    return resolveMaybePluginRelative(registryPluginRoot, localDistArg);
  }
  return typeof marker.localMcpEntry === 'string' ? marker.localMcpEntry : null;
}

function resolveCodexMcpConfigMode(
  localDistArg: string | null,
  hasWrapper: boolean
): CodexMcpConfigMode {
  if (localDistArg) {
    return 'local-dev-direct-dist';
  }
  return hasWrapper ? 'marketplace-shell' : 'unknown';
}

function collectCodexMcpEntryStaleReasons(input: {
  configMode: CodexMcpConfigMode;
  hasWrapper: boolean;
  input: CodexMcpEntryDiagnosticsInput;
  localDistEntryExists: boolean | null;
  localDistPath: string | null;
  marker: CodexMcpEntryDiagnostics['cacheMarker'];
  runtimeTarballExists: boolean;
}): string[] {
  const staleReasons: string[] = [];
  if (input.configMode === 'local-dev-direct-dist' && input.localDistEntryExists === false) {
    staleReasons.push('local-dev-dist-entry-missing');
  }
  if (input.hasWrapper && input.input.wrapperPath && !existsSync(input.input.wrapperPath)) {
    staleReasons.push('startup-entry-missing');
  }
  if (input.marker.exists && input.marker.mode === 'local-mcp') {
    collectLocalMcpMarkerStaleReasons(input, staleReasons);
  }
  collectRefreshMarkerStaleReasons(input, staleReasons);
  return staleReasons;
}

function collectRefreshMarkerStaleReasons(
  input: {
    configMode: CodexMcpConfigMode;
    input: CodexMcpEntryDiagnosticsInput;
    marker: CodexMcpEntryDiagnostics['cacheMarker'];
  },
  staleReasons: string[]
): void {
  if (
    input.marker.exists &&
    input.marker.entryMode &&
    input.marker.entryMode !== input.configMode &&
    input.configMode !== 'unknown'
  ) {
    staleReasons.push('refresh-marker-entry-mode-mismatch');
  }
  if (
    input.marker.exists &&
    input.marker.packageVersion &&
    input.input.packageVersion &&
    input.marker.packageVersion !== input.input.packageVersion
  ) {
    staleReasons.push('refresh-marker-package-version-mismatch');
  }
  if (
    input.marker.exists &&
    input.marker.pluginVersion &&
    input.input.pluginVersion &&
    input.marker.pluginVersion !== input.input.pluginVersion
  ) {
    staleReasons.push('refresh-marker-plugin-version-mismatch');
  }
  if (
    input.marker.exists &&
    input.marker.mode === 'packaged-runtime' &&
    input.configMode !== 'marketplace-shell'
  ) {
    staleReasons.push('refresh-marker-packaged-but-config-not-shell');
  }
}

function collectLocalMcpMarkerStaleReasons(
  input: {
    configMode: CodexMcpConfigMode;
    input: CodexMcpEntryDiagnosticsInput;
    localDistPath: string | null;
    marker: CodexMcpEntryDiagnostics['cacheMarker'];
  },
  staleReasons: string[]
): void {
  if (input.configMode !== 'local-dev-direct-dist') {
    staleReasons.push('refresh-marker-local-mcp-but-config-not-local-dist');
  }
  if (input.marker.localMcpEntry && input.localDistPath) {
    const markerEntry = resolveMaybePluginRelative(
      input.input.registryPluginRoot,
      input.marker.localMcpEntry
    );
    if (markerEntry !== input.localDistPath) {
      staleReasons.push('refresh-marker-local-entry-mismatch');
    }
  }
  if (input.marker.entryMode && input.marker.entryMode !== 'local-dev-direct-dist') {
    staleReasons.push('refresh-marker-local-entry-mode-mismatch');
  }
}

function buildWrapperStartupLockDiagnostics(
  wrapperSource: string
): CodexWrapperStartupLockDiagnostics {
  const configured =
    wrapperSource.includes('acquireRuntimeLock') && wrapperSource.includes('lockDir');
  const releaseSignals = [
    wrapperSource.includes('releaseRuntimeLock') ? 'finally-release' : null,
    wrapperSource.includes('runtime-lock-acquired') ? 'lock-acquired' : null,
    wrapperSource.includes('runtime-lock-stale-removed') ? 'stale-removed' : null,
    wrapperSource.includes('ALEMBIC_CODEX_RUNTIME_LOCK_TIMEOUT') ? 'timeout-diagnostic' : null,
  ].filter((signal): signal is string => typeof signal === 'string');
  let scope: CodexWrapperStartupLockDiagnostics['scope'] = 'missing';
  if (configured) {
    scope = 'global-cache-base';
  }
  if (
    wrapperSource.includes('lockScope') &&
    wrapperSource.includes('pluginRoot') &&
    wrapperSource.includes('runtimeTarball')
  ) {
    scope = 'plugin-root-runtime-tarball';
  }
  return {
    cacheParentCreation:
      wrapperSource.includes('mkdirSync(cache.installRoot') &&
      wrapperSource.includes('recursive: true'),
    configured,
    holdTimeoutEnv: 'not-used',
    ownerMetadata:
      wrapperSource.includes('owner.json') &&
      wrapperSource.includes('acquiredAtMs') &&
      wrapperSource.includes('source'),
    releaseSignals,
    runtimeTarballPreflight: false,
    scope,
    staleTimeoutEnv: 'ALEMBIC_CODEX_LOCK_STALE_MS',
    timeoutEnv: 'ALEMBIC_CODEX_LOCK_TIMEOUT_MS',
    waitDiagnostics:
      wrapperSource.includes('delay(') &&
      wrapperSource.includes('timeoutMs') &&
      wrapperSource.includes('ALEMBIC_CODEX_RUNTIME_LOCK_TIMEOUT'),
    nextAction: configured
      ? 'If startup waits or times out, inspect the runtime cache .install.lock owner metadata or run npm run dev:codex-plugin:reload.'
      : 'Restore the packaged startup install lock before shipping the Codex plugin.',
  };
}

function readInstalledRefreshMarker(path: string): CodexMcpEntryDiagnostics['cacheMarker'] {
  const marker = readJsonIfExists(path);
  return {
    canonicalLocalDevCommand: stringOrNull(marker?.canonicalLocalDevCommand),
    entryMode: stringOrNull(marker?.entryMode),
    exists: Boolean(marker),
    gitHead: stringOrNull(marker?.gitHead),
    localMcpEntry: stringOrNull(marker?.localMcpEntry),
    mode: stringOrNull(marker?.mode),
    packageVersion: stringOrNull(marker?.packageVersion),
    pluginVersion: stringOrNull(marker?.pluginVersion),
    refreshedAt: stringOrNull(marker?.refreshedAt),
  };
}

function resolveMaybePluginRelative(pluginRoot: string, path: string): string {
  return path.startsWith('/') ? path : join(pluginRoot, path.replace(/^\.\//, ''));
}

function entryModeNextAction(mode: CodexMcpEntryDiagnostics['mode']): string {
  switch (mode) {
    case 'local-dev-direct-dist':
      return 'Use npm run dev:codex-plugin:reload after local source changes so installed caches keep pointing at the fresh dist build.';
    case 'marketplace-shell':
      return 'Use marketplace shell diagnostics when startup fails; the shell should target the exact pinned runtime package.';
    case 'stale-installed-cache':
      return 'Run npm run dev:codex-plugin:reload to rebuild, rewrite installed cache, and probe a fresh MCP startup. Restart Codex itself if the current host MCP transport is closed.';
    case 'unknown':
      return 'Inspect the installed .mcp.json; expected either local dist/bin/codex-mcp.js or ./bin/alembic-start.mjs.';
  }
}

function buildDiagnosticIssues(input: BuildDiagnosticIssuesInput): CodexDiagnosticIssue[] {
  return [
    ...buildProjectRootIssues(input),
    ...buildRuntimeCommandIssues(input),
    ...buildRuntimeIdentityIssues(input),
    ...buildPluginConfigurationIssues(input),
    ...buildResidentServiceContractIssues(input),
    ...buildAdminTierIssues(input),
  ];
}

function buildProjectRootIssues(input: BuildDiagnosticIssuesInput): CodexDiagnosticIssue[] {
  if (input.projectRootResolution && input.projectRootResolution.trust !== 'trusted') {
    const rejected = input.projectRootResolution.trust === 'rejected';
    return [
      {
        action:
          'Pass the current workspace directory as the projectRoot argument, then rerun the Alembic tool.',
        code: rejected ? 'CODEX_PROJECT_ROOT_REJECTED' : 'CODEX_PROJECT_ROOT_UNRESOLVED',
        message: buildCodexProjectRootRequiredMessage(input.projectRootResolution),
        severity: 'error',
      },
    ];
  }
  return [];
}

function buildRuntimeCommandIssues(input: BuildDiagnosticIssuesInput): CodexDiagnosticIssue[] {
  const issues: CodexDiagnosticIssue[] = [];
  if (!input.checks.node) {
    issues.push({
      action:
        'Install Node.js 22 LTS or newer, then restart Codex. Keep MCP and daemon on the same Node executable.',
      code: 'NODE_VERSION_UNSUPPORTED',
      message: `Alembic Codex requires Node.js >=22; current runtime is ${process.versions.node}.`,
      severity: 'error',
    });
  }
  const staleCommandCwd = input.npm.staleCwd === true || input.npx.staleCwd === true;
  if (staleCommandCwd) {
    issues.push({
      action:
        'Restart Codex itself or open a new Codex session so diagnostics no longer inherit a deleted plugin cache working directory.',
      code: 'CODEX_STALE_COMMAND_CWD',
      message:
        'npm/npx failed with uv_cwd, which usually means the current Alembic Codex MCP process still holds a plugin cache directory that was replaced during cache refresh. The plugin runtime pin is separate from this stale cwd condition.',
      severity: 'error',
    });
  }
  if (!input.checks.npm && input.npm.staleCwd !== true) {
    issues.push({
      action: 'Install npm or use a Node.js distribution that includes npm.',
      code: 'NPM_UNAVAILABLE',
      message: String(input.npm.error || 'npm is not available.'),
      severity: 'error',
    });
  }
  return issues;
}

function buildRuntimeIdentityIssues(input: BuildDiagnosticIssuesInput): CodexDiagnosticIssue[] {
  if (!input.checks.runtimeMode || !input.checks.runtimePluginHost) {
    return [
      {
        action:
          'Start Alembic Codex with ALEMBIC_RUNTIME_MODE=plugin and ALEMBIC_PLUGIN_HOST=codex.',
        code: 'RUNTIME_IDENTITY_MISMATCH',
        message: `Current runtime identity is ALEMBIC_RUNTIME_MODE=${input.runtimeMode}, ALEMBIC_PLUGIN_HOST=${input.pluginHost}.`,
        severity: 'error',
      },
    ];
  }
  return [];
}

function buildPluginConfigurationIssues(input: BuildDiagnosticIssuesInput): CodexDiagnosticIssue[] {
  const issues: CodexDiagnosticIssue[] = [];
  if (!input.checks.packagePin) {
    issues.push({
      action:
        'Update plugins/alembic-codex/.mcp.json to launch ./bin/alembic-start.mjs, then run npm run prepare:codex-plugin-runtime.',
      code: 'PLUGIN_RUNTIME_PIN_MISMATCH',
      message: 'Codex plugin MCP config is not using the pinned Alembic Codex runtime package.',
      severity: 'error',
    });
  }
  if (!input.checks.pluginMcp && input.checks.packagePin) {
    issues.push({
      action:
        'Restore plugins/alembic-codex/.mcp.json Codex env defaults: ALEMBIC_RUNTIME_MODE=plugin, ALEMBIC_PLUGIN_HOST=codex, ALEMBIC_MCP_MODE=1, ALEMBIC_CODEX_MCP_MODE=1, ALEMBIC_MCP_TIER=agent, ALEMBIC_CODEX_ENABLE_ADMIN=0.',
      code: 'PLUGIN_MCP_ENV_INCOMPLETE',
      message: 'Codex plugin MCP config is missing required Codex runtime environment defaults.',
      severity: 'error',
    });
  }
  if (!input.checks.pluginMcpEntry) {
    issues.push(buildPluginMcpEntryIssue(input.plugin.mcp.entry));
  }
  if (!input.checks.pluginManifest || !input.plugin.readme.ok) {
    issues.push({
      action: 'Run npm run verify:codex-plugin and repair plugin metadata before publishing.',
      code: 'PLUGIN_METADATA_INCOMPLETE',
      message: 'Codex plugin manifest or README metadata is incomplete.',
      severity: 'error',
    });
  }
  if (!input.checks.pluginAssets || !input.checks.pluginSkills) {
    issues.push({
      action: 'Restore missing plugin assets or skills under plugins/alembic-codex.',
      code: 'PLUGIN_ASSETS_OR_SKILLS_MISSING',
      message: 'Codex plugin assets or skills are missing from the package.',
      severity: 'error',
    });
  }
  return issues;
}

function buildPluginMcpEntryIssue(entry: CodexMcpEntryDiagnostics): CodexDiagnosticIssue {
  const stale = entry.mode === 'stale-installed-cache';
  return {
    action: stale
      ? 'Run npm run dev:codex-plugin:reload so installed Codex plugin caches point to a fresh local dist build.'
      : 'Inspect plugins/alembic-codex/.mcp.json and the installed cache marker so diagnostics can classify the MCP entry mode.',
    code: stale ? 'CODEX_MCP_ENTRY_STALE_CACHE' : 'CODEX_MCP_ENTRY_MODE_UNKNOWN',
    message: stale
      ? `Installed Codex plugin cache is stale: ${entry.staleReasons.join(', ')}.`
      : 'Codex plugin MCP entry mode is neither marketplace shell nor local-dev direct dist.',
    severity: 'error',
  };
}

function buildResidentServiceContractIssues(
  input: BuildDiagnosticIssuesInput
): CodexDiagnosticIssue[] {
  if (!input.checks.residentServiceContract) {
    return [
      {
        action:
          'Refresh @alembic/core and the Codex plugin runtime artifact so resident service status uses the supported contract version.',
        code: 'RESIDENT_SERVICE_CONTRACT_UNSUPPORTED',
        message: 'Resident service status uses an unsupported contract version.',
        severity: 'error',
      },
    ];
  }
  return [];
}

function buildAdminTierIssues(input: BuildDiagnosticIssuesInput): CodexDiagnosticIssue[] {
  if (input.requestedTier === 'admin' && !input.adminEnabled) {
    return [
      {
        action: `Set ${CODEX_ADMIN_ENABLE_ENV}=1 only for explicit admin workflows.`,
        code: 'CODEX_ADMIN_OPT_IN_REQUIRED',
        message: 'Admin tier was requested, but the Codex-specific admin opt-in is disabled.',
        severity: 'warning',
      },
    ];
  }
  return [];
}

function buildResidentServiceBoundary(
  residentService: AlembicResidentServiceProbe | undefined
): Record<string, unknown> | null {
  if (!residentService) {
    return null;
  }
  const status = residentService.status;
  const localAlembicResident =
    status.route === 'local-alembic-daemon' && status.owner === 'alembic';
  const embeddedHostAgentRecovery =
    status.route === 'embedded-plugin-runtime' && status.owner === 'alembic-plugin';
  return {
    embeddedHostAgentRecovery,
    localAlembicResident,
    owner: status.owner,
    route: status.route,
    serviceScope: status.serviceScope,
    note: embeddedHostAgentRecovery
      ? 'embedded-plugin-runtime recovers Codex host-agent jobs and is not Alembic resident enhancement.'
      : localAlembicResident
        ? 'local-alembic-daemon is the canonical Alembic resident service route.'
        : 'resident service is unavailable or not owned by local Alembic.',
  };
}

function buildDiagnosticNextActions(issues: CodexDiagnosticIssue[]): string[] {
  if (issues.length === 0) {
    return ['Alembic Codex runtime checks passed.'];
  }
  return [...new Set(issues.map((issue) => issue.action))];
}

function buildDiagnosticSummary(issues: CodexDiagnosticIssue[]): string {
  if (issues.length === 0) {
    return 'Alembic Codex runtime checks passed. Continue with status, init, bootstrap, or priming.';
  }
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const parts = [];
  if (errorCount > 0) {
    parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
  }
  if (warningCount > 0) {
    parts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
  }
  return `Alembic Codex diagnostics found ${parts.join(' and ')}. Review issues before starting project knowledge workflows.`;
}

function buildRecommendedAction(input: {
  arguments?: Record<string, unknown>;
  label: string;
  reason: string;
  startsDaemon: boolean;
  tool: string;
}) {
  return {
    arguments: input.arguments || {},
    label: input.label,
    reason: input.reason,
    startsDaemon: input.startsDaemon,
    tool: input.tool,
  };
}

export function probeCodexRuntimeCommand(
  command: string,
  context: CodexRuntimeContext = resolveCodexRuntimeContext(),
  runner: CodexCommandProbeRunner = spawnSync
): CodexCommandProbeResult {
  const cwd = resolveDiagnosticsCommandCwd(context);
  const result = runner(command, ['--version'], {
    ...(cwd ? { cwd } : {}),
    encoding: 'utf8',
    timeout: 2000,
  });
  const output = stringifyProbeOutput(result.stdout || result.stderr || '').trim();
  const error = result.error?.message || output || `Unable to run ${command}`;
  return {
    available: result.status === 0,
    cwd,
    version: result.status === 0 ? output : null,
    error: result.status === 0 ? null : error,
    staleCwd: isUvCwdError(error),
  };
}

function resolveDiagnosticsCommandCwd(context: CodexRuntimeContext): string | null {
  const candidates = [context.pluginRoot, context.packageRoot, tmpdir()];
  for (const candidate of candidates) {
    if (isExistingDirectory(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isExistingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function stringifyProbeOutput(value: Buffer | string): string {
  return typeof value === 'string' ? value : value.toString('utf8');
}

function isUvCwdError(message: string): boolean {
  return /\buv_cwd\b/.test(message) || /no such file or directory,\s*uv_cwd/i.test(message);
}

function readJsonIfExists(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readHealthVersion(health: Record<string, unknown> | null): string | null {
  const data = health?.data;
  if (!data || typeof data !== 'object') {
    return null;
  }
  const version = (data as { version?: unknown }).version;
  return typeof version === 'string' ? version : null;
}

function readHealthGitDiffCheckpoint(
  health: Record<string, unknown> | null
): GitDiffCheckpointStatus | null {
  const data = health?.data;
  if (!data || typeof data !== 'object') {
    return null;
  }
  const status = (data as { gitDiffCheckpoint?: unknown }).gitDiffCheckpoint;
  if (!status || typeof status !== 'object') {
    return null;
  }
  return status as GitDiffCheckpointStatus;
}
