import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlembicResidentServiceProbe } from '@alembic/core/daemon';
import type { DaemonStatus } from '../../daemon/DaemonSupervisor.js';
import type { GitDiffCheckpointStatus } from '../../service/evolution/git-diff-checkpoint/index.js';
import type { AlembicResidentProjectScopeIdentity } from '../../service/resident/AlembicResidentServiceClient.js';
import {
  buildCodexEnhancementRouteChoice,
  type CodexEnhancementRouteChoice,
} from '../EnhancementRoute.js';
import type { CodexHostProjectAlignment } from '../HostProjectAlignment.js';
import {
  buildCodexModuleBoundaryStatus,
  type CodexModuleBoundaryStatus,
} from '../ModuleBoundary.js';
import { asString, CODEX_REQUIRED_SKILLS, loadCodexPluginRegistry } from '../PluginRegistry.js';
import {
  buildCodexProjectRootRequiredMessage,
  type CodexProjectRootResolution,
  summarizeCodexProjectRootResolution,
} from '../ProjectRootResolver.js';
import type { CodexProjectRuntimeContext } from '../runtime/ProjectRuntimeContext.js';
import {
  ALEMBIC_PLUGIN_HOST_ENV,
  ALEMBIC_RUNTIME_MODE_ENV,
  ALEMBIC_RUNTIME_MODE_PLUGIN,
  CODEX_ADMIN_ENABLE_ENV,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MCP_MODE_ENV,
  CODEX_MCP_SHIM_ENV,
  CODEX_PLUGIN_HOST,
  CODEX_PLUGIN_NAME,
  type CodexRuntimeContext,
  resolveCodexRuntimeContext,
} from '../runtime/RuntimeContext.js';

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
    exists: boolean;
    gitHead: string | null;
    localMcpEntry: string | null;
    mode: string | null;
    refreshedAt: string | null;
  };
  command: string | null;
  localDistEntry: {
    exists: boolean | null;
    path: string | null;
  };
  mode: 'local-dev-direct-dist' | 'packaged-wrapper' | 'stale-installed-cache' | 'unknown';
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
  configured: boolean;
  holdTimeoutEnv: string;
  ownerMetadata: boolean;
  releaseSignals: string[];
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
  const checks = {
    adminGate: context.requestedTier !== 'admin' || context.adminEnabled,
    node: nodeMajor >= 22,
    npm: npmAvailable,
    npx: npxAvailable,
    runtimeMode: context.runtimeMode === context.expectedRuntimeMode,
    runtimePluginHost: context.pluginHost === context.expectedPluginHost,
    embeddedRuntime: plugin.mcp.embeddedRuntime,
    packagePin: plugin.mcp.packagePin,
    pluginHost: plugin.mcp.pluginHost,
    pluginRuntimeMode: plugin.mcp.runtimeMode,
    pluginAssets: plugin.assets.ok,
    pluginManifest: plugin.manifest.ok,
    pluginMcp: plugin.mcp.ok,
    pluginMcpEntry:
      plugin.mcp.entry.mode !== 'unknown' && plugin.mcp.entry.mode !== 'stale-installed-cache',
    pluginSkills: plugin.skills.ok,
    projectRoot:
      !options.projectRootResolution || options.projectRootResolution.trust === 'trusted',
    residentServiceContract:
      !options.residentService || options.residentService.status.contractVersion === 1,
  };
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
    node: {
      ok: checks.node,
      required: '>=22',
      recommended: '22 LTS',
      version: process.versions.node,
      execPath: process.execPath,
      modules: process.versions.modules,
    },
    commands: {
      npm,
      npx,
    },
    package: {
      name: context.runtimePackage,
      version: context.packageVersion,
      embeddedRuntime: plugin.mcp.embeddedRuntime,
      runtimeSpecifier: context.embeddedRuntimeSpecifier,
      pinnedSpecifier: context.pinnedRuntimeSpecifier,
      mcpBinary: context.runtimeBin,
    },
    projectRootResolution: options.projectRootResolution
      ? summarizeCodexProjectRootResolution(options.projectRootResolution)
      : null,
    autoInit: options.autoInit || null,
    hostProjectAlignment: options.hostProjectAlignment || null,
    enhancementRoute,
    residentService: options.residentService || null,
    residentServiceBoundary: buildResidentServiceBoundary(options.residentService),
    projectRuntime: options.projectRuntime || null,
    projectScopeIdentity: options.projectScopeIdentity || null,
    moduleBoundary,
    gitDiffCheckpoint: readHealthGitDiffCheckpoint(daemonStatus.health),
    plugin,
    daemon: {
      ready: daemonStatus.ready,
      status: daemonStatus.status,
      stateVersion: daemonStatus.state?.version || null,
      healthVersion: readHealthVersion(daemonStatus.health),
    },
    codex: {
      channelId: context.channelId,
      expectedChannelId: context.expectedChannelId,
      pluginHost: context.pluginHost,
      runtimeMode: context.runtimeMode,
      requestedTier: context.requestedTier,
      effectiveTier: context.effectiveTier,
      adminEnabled: context.adminEnabled,
      adminMode: context.adminEnabled
        ? `enabled-by-${CODEX_ADMIN_ENABLE_ENV}`
        : `disabled-requires-${CODEX_ADMIN_ENABLE_ENV}=1`,
    },
    runtimeIdentity: {
      mode: context.runtimeMode,
      expectedMode: context.expectedRuntimeMode,
      pluginHost: context.pluginHost,
      expectedPluginHost: context.expectedPluginHost,
      isPluginRuntime: context.runtimeMode === ALEMBIC_RUNTIME_MODE_PLUGIN,
      env: {
        mode: ALEMBIC_RUNTIME_MODE_ENV,
        pluginHost: ALEMBIC_PLUGIN_HOST_ENV,
        channelId: 'ALEMBIC_CHANNEL_ID',
      },
    },
    offlineFallback: {
      note: 'The Codex plugin ships Plugin runtime code in ./runtime and starts MCP through ./bin/alembic-codex-mcp-wrapper.mjs. The wrapper invokes npx against ./runtime.tgz with a per-process npm cache under a plugin-specific base and a startup lock. This embedded route is for Codex host-agent recovery, not Alembic resident enhancement. AlembicPlugin does not provide a root registry package fallback.',
      registryPackageFallback: false,
      localPackage: context.embeddedRuntimeSpecifier,
      command: context.runtimeBin,
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
  const args = registry.mcp.args;
  const packageIndex = args.indexOf('--package');
  const runtimeSpecifier = packageIndex >= 0 ? args[packageIndex + 1] || null : null;
  const command =
    typeof registry.mcp.server?.command === 'string' ? registry.mcp.server.command : null;
  const wrapperArg = args.find((arg) => arg.endsWith('alembic-codex-mcp-wrapper.mjs')) || null;
  const wrapperPath = wrapperArg
    ? join(registry.plugin.root, wrapperArg.replace(/^\.\//, ''))
    : null;
  const wrapperSource =
    wrapperPath && existsSync(wrapperPath) ? readFileSync(wrapperPath, 'utf8') : '';
  const runtimeTarballPath = join(registry.plugin.root, 'runtime.tgz');
  const wrapperUsesRuntime =
    wrapperSource.includes('npx') &&
    wrapperSource.includes('--package') &&
    wrapperSource.includes(context.embeddedRuntimeSpecifier) &&
    wrapperSource.includes(context.runtimeBin);
  const wrapperUsesStartupLock =
    wrapperSource.includes('lockDir') && wrapperSource.includes('npm_config_cache');
  const entry = buildCodexMcpEntryDiagnostics({
    args,
    command,
    registryPluginRoot: registry.plugin.root,
    runtimeTarballPath,
    wrapperArg,
    wrapperPath,
  });
  const startupLockDiagnostics = buildWrapperStartupLockDiagnostics(wrapperSource);
  const binary =
    args.find((arg) => arg === context.runtimeBin) ||
    (wrapperUsesRuntime ? context.runtimeBin : null);
  const embeddedRuntime =
    command === 'node' &&
    wrapperUsesRuntime &&
    wrapperUsesStartupLock &&
    binary === context.runtimeBin &&
    !args.includes('latest');
  const packagePin = embeddedRuntime;
  const adminDisabledByDefault = registry.mcp.env?.[CODEX_ADMIN_ENABLE_ENV] === '0';
  const agentTierByDefault = registry.mcp.env?.ALEMBIC_MCP_TIER === CODEX_DEFAULT_MCP_TIER;
  const pluginHostValue =
    typeof registry.mcp.env?.[ALEMBIC_PLUGIN_HOST_ENV] === 'string'
      ? registry.mcp.env[ALEMBIC_PLUGIN_HOST_ENV]
      : null;
  const runtimeModeValue =
    typeof registry.mcp.env?.[ALEMBIC_RUNTIME_MODE_ENV] === 'string'
      ? registry.mcp.env[ALEMBIC_RUNTIME_MODE_ENV]
      : null;
  const pluginHost = pluginHostValue === CODEX_PLUGIN_HOST;
  const runtimeMode = runtimeModeValue === ALEMBIC_RUNTIME_MODE_PLUGIN;
  const mcpMode = registry.mcp.env?.[CODEX_MCP_MODE_ENV] === '1';
  const codexShimMode = registry.mcp.env?.[CODEX_MCP_SHIM_ENV] === '1';
  const missingAssets = registry.plugin.assets.filter(
    (asset) => !existsSync(join(registry.plugin.root, asset))
  );
  const requiredSkills = [...CODEX_REQUIRED_SKILLS];
  const missingSkills = requiredSkills.filter(
    (skill) => !existsSync(join(registry.plugin.root, 'skills', skill, 'SKILL.md'))
  );
  const mentionsEmbeddedRuntime = registry.plugin.readme.includes(context.embeddedRuntimeSpecifier);
  const mentionsPinnedRuntime = registry.plugin.readme.includes(context.pinnedRuntimeSpecifier);
  const readmeOk = mentionsEmbeddedRuntime && mentionsPinnedRuntime;

  return {
    assets: {
      missing: missingAssets,
      ok: registry.plugin.assets.length > 0 && missingAssets.length === 0,
      required: registry.plugin.assets,
    },
    manifest: {
      ok:
        registry.plugin.manifest.ok &&
        asString(registry.plugin.manifest.value?.name) === CODEX_PLUGIN_NAME,
      path: registry.plugin.manifest.path,
      version: asString(registry.plugin.manifest.value?.version) || null,
    },
    mcp: {
      adminDisabledByDefault,
      agentTierByDefault,
      binary,
      codexShimMode,
      command,
      embeddedRuntime,
      mcpMode,
      ok:
        embeddedRuntime &&
        adminDisabledByDefault &&
        agentTierByDefault &&
        pluginHost &&
        runtimeMode &&
        mcpMode &&
        codexShimMode,
      packagePin,
      path: registry.mcp.json.path,
      pluginHost,
      pluginHostValue,
      pinnedSpecifier: context.embeddedRuntimeSpecifier,
      runtimeMode,
      runtimeModeValue,
      runtimeSpecifier: runtimeSpecifier || context.embeddedRuntimeSpecifier,
      entry,
      wrapper: {
        exists: Boolean(wrapperPath && existsSync(wrapperPath)),
        path: wrapperPath,
        startupLock: wrapperUsesStartupLock,
        startupLockDiagnostics,
      },
    },
    ok:
      registry.plugin.manifest.ok &&
      embeddedRuntime &&
      adminDisabledByDefault &&
      agentTierByDefault &&
      pluginHost &&
      runtimeMode &&
      mcpMode &&
      codexShimMode &&
      missingAssets.length === 0 &&
      missingSkills.length === 0 &&
      readmeOk,
    readme: {
      mentionsEmbeddedRuntime,
      mentionsPinnedRuntime,
      ok: readmeOk,
      path: registry.plugin.readmePath,
    },
    root: registry.plugin.root,
    skills: {
      missing: missingSkills,
      ok: missingSkills.length === 0,
      required: requiredSkills,
    },
  };
}

function buildCodexMcpEntryDiagnostics(input: {
  args: string[];
  command: string | null;
  registryPluginRoot: string;
  runtimeTarballPath: string;
  wrapperArg: string | null;
  wrapperPath: string | null;
}): CodexMcpEntryDiagnostics {
  const marker = readInstalledRefreshMarker(
    join(input.registryPluginRoot, '.alembic-dev-refresh.json')
  );
  const localDistArg =
    input.args.find(
      (arg) => arg.endsWith('/dist/bin/codex-mcp.js') || arg.endsWith('dist/bin/codex-mcp.js')
    ) || null;
  const localDistPath = localDistArg
    ? resolveMaybePluginRelative(input.registryPluginRoot, localDistArg)
    : typeof marker.localMcpEntry === 'string'
      ? marker.localMcpEntry
      : null;
  const localDistEntryExists = localDistPath ? existsSync(localDistPath) : null;
  const runtimeTarballExists = existsSync(input.runtimeTarballPath);
  const hasWrapper = Boolean(input.wrapperArg);
  const staleReasons: string[] = [];
  const configMode = localDistArg
    ? 'local-dev-direct-dist'
    : hasWrapper
      ? 'packaged-wrapper'
      : 'unknown';

  if (configMode === 'local-dev-direct-dist' && localDistEntryExists === false) {
    staleReasons.push('local-dev-dist-entry-missing');
  }
  if (configMode === 'packaged-wrapper' && !runtimeTarballExists) {
    staleReasons.push('runtime-tarball-missing');
  }
  if (hasWrapper && input.wrapperPath && !existsSync(input.wrapperPath)) {
    staleReasons.push('wrapper-entry-missing');
  }
  if (marker.exists && marker.mode === 'local-mcp' && configMode !== 'local-dev-direct-dist') {
    staleReasons.push('refresh-marker-local-mcp-but-config-not-local-dist');
  }
  if (marker.exists && marker.mode === 'packaged-runtime' && configMode !== 'packaged-wrapper') {
    staleReasons.push('refresh-marker-packaged-but-config-not-wrapper');
  }
  if (marker.exists && marker.mode === 'local-mcp' && marker.localMcpEntry && localDistPath) {
    const markerEntry = resolveMaybePluginRelative(input.registryPluginRoot, marker.localMcpEntry);
    if (markerEntry !== localDistPath) {
      staleReasons.push('refresh-marker-local-entry-mismatch');
    }
  }

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

function buildWrapperStartupLockDiagnostics(
  wrapperSource: string
): CodexWrapperStartupLockDiagnostics {
  const configured =
    wrapperSource.includes('acquireStartupLock') && wrapperSource.includes('lockDir');
  const releaseSignals = [
    wrapperSource.includes("releaseStartupLock('stdout')") ? 'stdout' : null,
    wrapperSource.includes("releaseStartupLock('stderr')") ? 'stderr' : null,
    wrapperSource.includes("releaseStartupLock('child-exit')") ? 'child-exit' : null,
    wrapperSource.includes("releaseStartupLock('child-error')") ? 'child-error' : null,
    wrapperSource.includes("releaseStartupLock('hold-timeout')") ? 'hold-timeout' : null,
  ].filter((signal): signal is string => typeof signal === 'string');
  return {
    configured,
    holdTimeoutEnv: 'ALEMBIC_CODEX_NPM_LOCK_HOLD_MS',
    ownerMetadata:
      wrapperSource.includes('owner.json') &&
      wrapperSource.includes('pluginRoot') &&
      wrapperSource.includes('runtimeTarball'),
    releaseSignals,
    scope:
      wrapperSource.includes('lockScope') &&
      wrapperSource.includes('pluginRoot') &&
      wrapperSource.includes('runtimeTarball')
        ? 'plugin-root-runtime-tarball'
        : configured
          ? 'global-cache-base'
          : 'missing',
    staleTimeoutEnv: 'ALEMBIC_CODEX_NPM_LOCK_STALE_MS',
    timeoutEnv: 'ALEMBIC_CODEX_NPM_LOCK_TIMEOUT_MS',
    waitDiagnostics:
      wrapperSource.includes('startup-lock-wait') &&
      wrapperSource.includes('waitMs') &&
      wrapperSource.includes('timeoutMs') &&
      wrapperSource.includes('nextAction'),
    nextAction: configured
      ? 'If startup waits or times out, inspect the wrapper lock owner metadata or run npm run dev:codex-plugin:reload.'
      : 'Restore the packaged wrapper startup lock before shipping the Codex plugin.',
  };
}

function readInstalledRefreshMarker(path: string): CodexMcpEntryDiagnostics['cacheMarker'] {
  const marker = readJsonIfExists(path);
  return {
    exists: Boolean(marker),
    gitHead: stringOrNull(marker?.gitHead),
    localMcpEntry: stringOrNull(marker?.localMcpEntry),
    mode: stringOrNull(marker?.mode),
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
    case 'packaged-wrapper':
      return 'Use packaged runtime diagnostics when startup fails; wrapper lock waits should report owner, wait reason, timeout, and next action.';
    case 'stale-installed-cache':
      return 'Run npm run dev:codex-plugin:reload to rebuild, rewrite installed cache, stop old MCP processes, and probe the next startup.';
    case 'unknown':
      return 'Inspect the installed .mcp.json; expected either local dist/bin/codex-mcp.js or ./bin/alembic-codex-mcp-wrapper.mjs.';
  }
}

function buildDiagnosticIssues(input: {
  adminEnabled: boolean;
  checks: Record<string, boolean>;
  npm: CodexCommandProbeResult;
  npx: CodexCommandProbeResult;
  packageVersion: string;
  pluginHost: string;
  plugin: CodexPluginDiagnostics;
  projectRootResolution?: CodexProjectRootResolution;
  requestedTier: string;
  runtimeMode: string;
}): CodexDiagnosticIssue[] {
  const issues: CodexDiagnosticIssue[] = [];
  if (input.projectRootResolution && input.projectRootResolution.trust !== 'trusted') {
    const rejected = input.projectRootResolution.trust === 'rejected';
    issues.push({
      action:
        'Pass the current workspace directory as the projectRoot argument, then rerun the Alembic tool.',
      code: rejected ? 'CODEX_PROJECT_ROOT_REJECTED' : 'CODEX_PROJECT_ROOT_UNRESOLVED',
      message: buildCodexProjectRootRequiredMessage(input.projectRootResolution),
      severity: 'error',
    });
  }
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
        'Restart the Alembic Codex MCP process or open a new Codex session so diagnostics no longer inherit a deleted plugin cache working directory.',
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
  if (!input.checks.npx && input.npx.staleCwd !== true) {
    issues.push({
      action:
        'Install npm/npx support so the Codex plugin wrapper can launch the embedded ./runtime.tgz artifact.',
      code: 'NPX_UNAVAILABLE',
      message: String(input.npx.error || 'npx is not available.'),
      severity: 'error',
    });
  }
  if (!input.checks.runtimeMode || !input.checks.runtimePluginHost) {
    issues.push({
      action: 'Start Alembic Codex with ALEMBIC_RUNTIME_MODE=plugin and ALEMBIC_PLUGIN_HOST=codex.',
      code: 'RUNTIME_IDENTITY_MISMATCH',
      message: `Current runtime identity is ALEMBIC_RUNTIME_MODE=${input.runtimeMode}, ALEMBIC_PLUGIN_HOST=${input.pluginHost}.`,
      severity: 'error',
    });
  }
  if (!input.checks.packagePin) {
    issues.push({
      action:
        'Update plugins/alembic-codex/.mcp.json to launch ./bin/alembic-codex-mcp-wrapper.mjs, then run npm run prepare:codex-plugin-runtime.',
      code: 'PLUGIN_RUNTIME_PIN_MISMATCH',
      message:
        'Codex plugin MCP config is not using the embedded Alembic runtime tarball from ./runtime.tgz.',
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
    const stale = input.plugin.mcp.entry.mode === 'stale-installed-cache';
    issues.push({
      action: stale
        ? 'Run npm run dev:codex-plugin:reload so installed Codex plugin caches point to a fresh local dist build.'
        : 'Inspect plugins/alembic-codex/.mcp.json and the installed cache marker so diagnostics can classify the MCP entry mode.',
      code: stale ? 'CODEX_MCP_ENTRY_STALE_CACHE' : 'CODEX_MCP_ENTRY_MODE_UNKNOWN',
      message: stale
        ? `Installed Codex plugin cache is stale: ${input.plugin.mcp.entry.staleReasons.join(', ')}.`
        : 'Codex plugin MCP entry mode is neither packaged wrapper nor local-dev direct dist.',
      severity: 'error',
    });
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
  if (!input.checks.residentServiceContract) {
    issues.push({
      action:
        'Refresh @alembic/core and the Codex plugin runtime artifact so resident service status uses the supported contract version.',
      code: 'RESIDENT_SERVICE_CONTRACT_UNSUPPORTED',
      message: 'Resident service status uses an unsupported contract version.',
      severity: 'error',
    });
  }
  if (input.requestedTier === 'admin' && !input.adminEnabled) {
    issues.push({
      action: `Set ${CODEX_ADMIN_ENABLE_ENV}=1 only for explicit admin workflows.`,
      code: 'CODEX_ADMIN_OPT_IN_REQUIRED',
      message: 'Admin tier was requested, but the Codex-specific admin opt-in is disabled.',
      severity: 'warning',
    });
  }
  return issues;
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
