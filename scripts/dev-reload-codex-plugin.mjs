#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const options = readOptions(process.argv.slice(2));
const report = {
  ok: false,
  mode: 'local-dev-reload',
  canonicalCommand: 'npm run dev:codex-plugin:reload',
  legacyAlias: options.legacyAlias,
  mcpProcessHandling: 'not-managed-by-plugin',
  projectRoot: options.projectRoot,
  readbackProof: buildReadbackProofSummary(),
  runtimeModeSeparation: buildRuntimeModeSeparation(),
  steps: [],
  sync: null,
  probe: null,
};

if (options.legacyAlias) {
  process.stderr.write(
    `dev:codex-plugin:${options.legacyAlias} is a compatibility alias; use dev:codex-plugin:reload as the canonical local-dev reload command.\n`
  );
}

try {
  if (options.dryRun) {
    report.ok = true;
    report.plan = buildDryRunPlan();
    printReport();
    process.exit(0);
  }

  if (!options.skipBuild) {
    runStep('build local Codex MCP runtime', 'npm', ['run', 'build']);
  }
  if (!options.skipPrepare) {
    runStep('prepare packaged marketplace shell', 'npm', ['run', 'prepare:codex-plugin-runtime']);
  }

  report.sync = runSync();
  report.steps.push({
    command: 'do not inspect, stop, or restart current Codex MCP processes',
    durationMs: 0,
    name: 'leave current host MCP lifecycle to Codex',
    status: 0,
    note: 'AlembicPlugin reload only refreshes installed plugin caches and probes a fresh MCP startup; restart Codex itself if the current host MCP transport is closed.',
  });

  if (!options.skipProbe) {
    report.probe = runProbe(report.sync?.targetRoots || []);
  }

  report.ok = true;
  printReport();
} catch (err) {
  const error = err instanceof Error ? err : new Error(String(err));
  report.error = {
    message: error.message,
  };
  printReport();
  process.exit(1);
}

function runSync() {
  const args = ['scripts/sync-codex-plugin-cache.mjs', '--clean', '--all-installed', '--local-mcp'];
  if (options.codexHome) {
    args.push('--codex-home', options.codexHome);
  }
  for (const target of options.syncTargets) {
    args.push('--target-root', target);
  }
  const result = runStep('rewrite installed cache to local dist MCP', process.execPath, args, {
    capture: true,
  });
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(`Could not parse cache sync summary: ${error.message}\n${result.stdout}`);
  }
}

function runProbe(targetRoots) {
  const args = [
    'scripts/dev-verify-codex-plugin.mjs',
    '--probe-only',
    '--project-root',
    options.projectRoot,
    '--report-path',
    options.probeReportPath,
    '--mcp-timeout-ms',
    String(options.mcpTimeoutMs),
  ];
  if (options.codexHome) {
    args.push('--codex-home', options.codexHome);
  }
  for (const targetRoot of targetRoots) {
    args.push('--probe-target', targetRoot);
  }
  const result = runStep('fresh MCP probe after reload', process.execPath, args, { capture: true });
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(`Could not parse MCP probe report: ${error.message}\n${result.stdout}`);
  }
}

function runStep(name, command, args, stepOptions = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    stdio: stepOptions.capture ? 'pipe' : 'inherit',
    env: {
      ...process.env,
      HUSKY: '0',
    },
  });
  const step = {
    command: [command, ...args].join(' '),
    durationMs: Date.now() - startedAt,
    name,
    status: result.status,
  };
  report.steps.push(step);
  if (result.status !== 0) {
    throw new Error(
      `${name} failed (${result.status})\n${result.stdout || ''}${result.stderr || ''}`
    );
  }
  return result;
}

function buildDryRunPlan() {
  const syncArgs = ['--clean', '--all-installed', '--local-mcp'];
  if (options.codexHome) {
    syncArgs.push('--codex-home', options.codexHome);
  }
  for (const target of options.syncTargets) {
    syncArgs.push('--target-root', target);
  }
  return {
    build: !options.skipBuild,
    prepareRuntime: !options.skipPrepare,
    currentHostMcpProcessLifecycle: 'not-managed-by-plugin',
    freshMcpReadback: buildReadbackProofSummary(),
    probe: !options.skipProbe,
    runtimeModeSeparation: buildRuntimeModeSeparation(),
    syncCommand: ['node', 'scripts/sync-codex-plugin-cache.mjs', ...syncArgs],
  };
}

function buildRuntimeModeSeparation() {
  return {
    activeMode: 'local-dev-direct-dist',
    localDev: {
      command: 'npm run dev:codex-plugin:reload',
      entryMode: 'local-dev-direct-dist',
      cacheRewrite: 'installed caches point at local dist/bin/codex-mcp.js',
      currentHostMcpProcessLifecycle: 'not-managed-by-plugin',
    },
    packaged: {
      command: 'plugins/alembic-codex/bin/alembic-start.mjs',
      entryMode: 'marketplace-shell',
      runtimeSpecifier: '@gxfn/alembic-runtime@0.2.0',
      cacheIsolation: 'owned by the marketplace shell bootstrap path',
      usedByReload: false,
    },
  };
}

function buildReadbackProofSummary() {
  return {
    expectedToolCall: 'alembic_status',
    expectedToolCalls: ['alembic_status'],
    expectedDiagnosticsTool: 'alembic_status',
    expectedEntryMode: 'local-dev-direct-dist',
    proves: [
      'fresh installed-cache MCP startup',
      'projectRuntime.identity projectRoot/dataRoot/runtimeDir/databasePath',
      'projectRuntime.sourcePolicy keeps Codex current project as effective identity',
      'fallback isolation blocks saved, selected/active, local JobStore, and embedded runtime identity fallbacks',
      'structured projectRuntime.failureEnvelopes array',
    ],
    probeReportPath: options.probeReportPath,
    requiresFreshProcess: true,
  };
}

function parseArgs(args) {
  const parsed = {
    codexHome: '',
    dryRun: false,
    legacyAlias: null,
    mcpTimeoutMs: 30000,
    probeReportPath: join(root, 'scratch', 'codex-plugin-dev-reload-probe-report.json'),
    projectRoot: root,
    reportPath: join(root, 'scratch', 'codex-plugin-dev-reload-report.json'),
    skipBuild: false,
    skipPrepare: false,
    skipProbe: false,
    syncTargets: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--codex-home') {
      parsed.codexHome = args[index + 1] || '';
      index += 1;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--legacy-refresh') {
      parsed.legacyAlias = 'refresh';
    } else if (arg === '--mcp-timeout-ms') {
      parsed.mcpTimeoutMs = Number(args[index + 1] || parsed.mcpTimeoutMs);
      index += 1;
    } else if (arg === '--stop-mcp' || arg === '--no-stop-mcp') {
      throw removedMcpLifecycleOptionError(arg);
    } else if (arg === '--project-root') {
      parsed.projectRoot = resolve(args[index + 1] || parsed.projectRoot);
      index += 1;
    } else if (arg === '--probe-report-path') {
      parsed.probeReportPath = resolve(args[index + 1] || parsed.probeReportPath);
      index += 1;
    } else if (arg === '--report-path') {
      parsed.reportPath = resolve(args[index + 1] || parsed.reportPath);
      index += 1;
    } else if (arg === '--skip-build') {
      parsed.skipBuild = true;
    } else if (arg === '--skip-prepare') {
      parsed.skipPrepare = true;
    } else if (arg === '--skip-probe') {
      parsed.skipProbe = true;
    } else if (arg === '--sync-target') {
      parsed.syncTargets.push(resolve(args[index + 1] || ''));
      index += 1;
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function readOptions(args) {
  try {
    return parseArgs(args);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

function removedMcpLifecycleOptionError(arg) {
  return new Error(
    `${arg} has been removed: AlembicPlugin does not manage the current Codex MCP process lifecycle. ` +
      'Run reload to refresh installed caches and probe fresh startup; restart Codex itself if the current transport is closed.'
  );
}

function printReport() {
  mkdirSync(dirname(options.reportPath), { recursive: true });
  writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ ...report, reportPath: options.reportPath }, null, 2)}\n`
  );
}

function printHelp() {
  process.stdout.write(`Canonical Alembic Codex plugin local-dev reload.

Usage:
  node scripts/dev-reload-codex-plugin.mjs [options]

Behavior:
  Builds the local Codex MCP runtime, verifies the marketplace shell, rewrites installed
  plugin cache roots to local dist/bin/codex-mcp.js and starts a fresh MCP probe
  against the rewritten cache. The probe calls alembic_status and validates
  projectRuntime identity, sourcePolicy, fallback isolation, entryMode, and
  failureEnvelopes. It never inspects, stops, or restarts the current Codex host
  MCP process. Restart Codex itself if the current transport is closed.

Options:
  --codex-home <path>          Override CODEX_HOME, defaults to ~/.codex.
  --project-root <path>        Project root used by the fresh MCP probe.
  --sync-target <path>         Extra installed plugin cache root to rewrite.
  --report-path <path>         Persist reload report.
  --probe-report-path <path>   Persist nested MCP probe report.
  --mcp-timeout-ms <ms>        MCP probe timeout, defaults to 30000.
  --skip-build                 Skip npm run build.
  --skip-prepare               Skip prepare:codex-plugin-runtime shell verification.
  --skip-probe                 Skip fresh MCP probe.
  --dry-run                    Print the reload plan without writing or probing.
  --legacy-refresh             Compatibility marker for dev:codex-plugin:refresh.
  -h, --help                   Show this help.
`);
}
