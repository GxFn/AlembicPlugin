#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const options = parseArgs(process.argv.slice(2));
const report = {
  ok: false,
  mode: 'local-dev-reload',
  canonicalCommand: 'npm run dev:codex-plugin:reload',
  legacyAlias: options.legacyAlias,
  projectRoot: options.projectRoot,
  steps: [],
  sync: null,
  stoppedProcesses: [],
  probe: null,
};

if (options.legacyAlias) {
  process.stderr.write(
    `dev:codex-plugin:${options.legacyAlias} is a compatibility alias; use dev:codex-plugin:reload as the canonical local-dev restart/reload command.\n`
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
    runStep('prepare packaged runtime tarball', 'npm', ['run', 'prepare:codex-plugin-runtime']);
  }

  report.sync = runSync();

  if (options.stopMcp) {
    report.stoppedProcesses = stopMcpProcesses(report.sync?.targetRoots || []);
  }

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

function stopMcpProcesses(targetRoots) {
  const localEntry = join(root, 'dist', 'bin', 'codex-mcp.js');
  const localWrapper = join(
    root,
    'plugins',
    'alembic-codex',
    'bin',
    'alembic-codex-mcp-wrapper.mjs'
  );
  const candidates = findMcpProcessCandidates(targetRoots, localEntry, localWrapper);
  const stopped = [];
  for (const candidate of candidates) {
    try {
      process.kill(candidate.pid, 'SIGTERM');
      stopped.push(candidate);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!('code' in error) || error.code !== 'ESRCH') {
        stopped.push({ ...candidate, error: error.message });
      }
    }
  }
  report.steps.push({
    command: 'SIGTERM running Alembic Codex MCP processes',
    durationMs: 0,
    name: 'stop old MCP processes',
    status: 0,
    stoppedPids: stopped.map((processInfo) => processInfo.pid),
  });
  return stopped;
}

function findMcpProcessCandidates(targetRoots, localEntry, localWrapper) {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (ps.status !== 0) {
    throw new Error(`Could not inspect running processes:\n${ps.stderr || ps.stdout}`);
  }
  const currentPid = process.pid;
  const normalizedTargets = targetRoots.map((target) => resolve(target));
  return ps.stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({ command: match[2], pid: Number(match[1]) }))
    .filter((processInfo) => processInfo.pid > 0 && processInfo.pid !== currentPid)
    .filter((processInfo) =>
      isAlembicCodexMcpProcess(processInfo.command, normalizedTargets, localEntry, localWrapper)
    );
}

function isAlembicCodexMcpProcess(command, targetRoots, localEntry, localWrapper) {
  if (command.includes(localEntry) || command.includes(localWrapper)) {
    return true;
  }
  return targetRoots.some(
    (targetRoot) =>
      command.includes(targetRoot) &&
      (command.includes('alembic-codex-mcp-wrapper.mjs') ||
        command.includes('alembic-codex-mcp') ||
        command.includes('codex-mcp.js'))
  );
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
    stopOldMcpProcesses: options.stopMcp,
    probe: !options.skipProbe,
    syncCommand: ['node', 'scripts/sync-codex-plugin-cache.mjs', ...syncArgs],
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
    stopMcp: true,
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
    } else if (arg === '--no-stop-mcp') {
      parsed.stopMcp = false;
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

function printReport() {
  mkdirSync(dirname(options.reportPath), { recursive: true });
  writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ ...report, reportPath: options.reportPath }, null, 2)}\n`
  );
}

function printHelp() {
  process.stdout.write(`Canonical Alembic Codex plugin local-dev restart/reload.

Usage:
  node scripts/dev-reload-codex-plugin.mjs [options]

Behavior:
  Builds the local Codex MCP runtime, prepares runtime.tgz, rewrites installed
  plugin cache roots to local dist/bin/codex-mcp.js, stops old Alembic Codex MCP
  processes, then starts a fresh MCP probe against the rewritten cache.

Options:
  --codex-home <path>          Override CODEX_HOME, defaults to ~/.codex.
  --project-root <path>        Project root used by the fresh MCP probe.
  --sync-target <path>         Extra installed plugin cache root to rewrite.
  --report-path <path>         Persist reload report.
  --probe-report-path <path>   Persist nested MCP probe report.
  --mcp-timeout-ms <ms>        MCP probe timeout, defaults to 30000.
  --skip-build                 Skip npm run build.
  --skip-prepare               Skip prepare:codex-plugin-runtime.
  --skip-probe                 Skip fresh MCP probe.
  --no-stop-mcp                Do not stop running Alembic Codex MCP processes.
  --dry-run                    Print the reload plan without writing or probing.
  --legacy-refresh             Compatibility marker for dev:codex-plugin:refresh.
  -h, --help                   Show this help.
`);
}
