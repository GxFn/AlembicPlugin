#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, resolveCoreGrammarSource } from './local-source-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const coreGrammarSource = resolveCoreGrammarSource();
const options = readOptions(process.argv.slice(2));
const watchEntries = [
  '.agents',
  'bin',
  'channels',
  'config',
  'injectable-skills',
  'lib',
  'package.json',
  'plugins/alembic-codex/.agents',
  'plugins/alembic-codex/.codex-plugin',
  'plugins/alembic-codex/.mcp.json',
  'plugins/alembic-codex/README.md',
  'plugins/alembic-codex/README.zh-CN.md',
  'plugins/alembic-codex/RELEASE-PLAYBOOK.md',
  'plugins/alembic-codex/assets',
  'plugins/alembic-codex/bin',
  'plugins/alembic-codex/skills',
  'README.md',
  'README_CN.md',
  relative(repoRoot, coreGrammarSource.path),
  'node_modules/@alembic/core/resources/grammars',
  'scripts/dev-reload-codex-plugin.mjs',
  'scripts/dev-verify-codex-plugin.mjs',
  'scripts/dev-watch-codex-plugin.mjs',
  'scripts/prepare-codex-plugin-runtime.mjs',
  'scripts/smoke-codex-plugin.mjs',
  'scripts/sync-codex-plugin-cache.mjs',
  'scripts/verify-codex-plugin.mjs',
  'template.json',
  'templates',
  'tsconfig.json',
];
const watchRoots = [...new Set(watchEntries.map((entry) => resolve(root, entry)))].filter((entry) =>
  existsSync(entry)
);
let snapshot = snapshotInputs();
let timer = null;
let poller = null;
let running = false;
let pending = false;
let stopped = false;

if (options.once) {
  await refresh('manual');
  process.exit(0);
}

process.stdout.write(
  `Polling ${watchRoots.length} Alembic Codex plugin inputs every ${options.pollMs}ms. Press Ctrl-C to stop.\n`
);
poller = setInterval(pollForChanges, options.pollMs);
if (options.initial) {
  scheduleRefresh('startup');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(poller);
    process.stdout.write(`Stopped Alembic Codex plugin watcher (${signal}).\n`);
    process.exit(0);
  });
}

function pollForChanges() {
  if (stopped) {
    return;
  }
  const nextSnapshot = snapshotInputs();
  const changes = diffSnapshots(snapshot, nextSnapshot);
  if (changes.length === 0) {
    return;
  }
  snapshot = nextSnapshot;
  scheduleRefresh(summarizeChanges(changes));
}

function scheduleRefresh(reason) {
  if (stopped) {
    return;
  }
  if (running) {
    pending = true;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => {
    void refresh(reason);
  }, options.debounceMs);
}

async function refresh(reason) {
  if (running) {
    pending = true;
    return;
  }

  running = true;
  pending = false;
  const startedAt = Date.now();
  process.stdout.write(`\nReloading Alembic Codex plugin after ${reason}...\n`);
  const result = spawnSync('npm', ['run', 'dev:codex-plugin:reload', '--', ...options.forward], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HUSKY: '0',
    },
    stdio: 'inherit',
  });

  if (result.status === 0) {
    process.stdout.write(`Alembic Codex plugin reload finished in ${Date.now() - startedAt}ms.\n`);
  } else {
    process.stderr.write(
      `Alembic Codex plugin reload failed with exit code ${result.status ?? 'unknown'}.\n`
    );
  }

  running = false;
  if (pending) {
    scheduleRefresh('queued changes');
  }
}

function shouldIgnore(filePath) {
  const relativePath = relative(root, filePath);
  const parts = relativePath.split(/[\\/]+/);
  return (
    parts.includes('.git') ||
    parts.includes('node_modules') ||
    parts.includes('dist') ||
    parts.includes('coverage') ||
    parts.includes('scratch') ||
    parts.includes('docs-dev') ||
    relativePath === 'plugins/alembic-codex/runtime.tgz' ||
    relativePath.startsWith('plugins/alembic-codex/runtime/')
  );
}

function snapshotInputs() {
  const files = new Map();
  for (const watchRoot of watchRoots) {
    collectSnapshot(watchRoot, files);
  }
  return files;
}

function collectSnapshot(filePath, files) {
  if (shouldIgnore(filePath)) {
    return;
  }
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    for (const entry of safeReaddir(filePath)) {
      collectSnapshot(join(filePath, entry), files);
    }
    return;
  }
  if (stats.isFile()) {
    files.set(relative(root, filePath), `${stats.size}:${stats.mtimeMs}`);
  }
}

function diffSnapshots(previous, next) {
  const changes = [];
  for (const [filePath, signature] of next) {
    if (previous.get(filePath) !== signature) {
      changes.push(filePath);
    }
  }
  for (const filePath of previous.keys()) {
    if (!next.has(filePath)) {
      changes.push(filePath);
    }
  }
  return changes.sort();
}

function summarizeChanges(changes) {
  const visible = changes.slice(0, 3).join(', ');
  if (changes.length <= 3) {
    return visible;
  }
  return `${visible}, and ${changes.length - 3} more`;
}

function safeReaddir(filePath) {
  try {
    return readdirSync(filePath);
  } catch {
    return [];
  }
}

function parseArgs(args) {
  const parsed = {
    debounceMs: 1000,
    forward: [],
    initial: true,
    once: false,
    pollMs: 1500,
    reportPath: join(root, 'scratch', 'codex-plugin-dev-verify-report.json'),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--debounce-ms') {
      parsed.debounceMs = Number(args[index + 1] || parsed.debounceMs);
      index += 1;
    } else if (arg === '--poll-ms') {
      parsed.pollMs = Number(args[index + 1] || parsed.pollMs);
      index += 1;
    } else if (arg === '--no-initial') {
      parsed.initial = false;
    } else if (arg === '--restart-mcp' || arg === '--no-restart-mcp') {
      throw removedMcpLifecycleOptionError(arg);
    } else if (arg === '--once') {
      parsed.once = true;
    } else if (arg === '--report-path') {
      parsed.reportPath = resolve(args[index + 1] || parsed.reportPath);
      parsed.forward.push(arg, parsed.reportPath);
      index += 1;
    } else if (
      [
        '--codex-home',
        '--mcp-timeout-ms',
        '--probe-target',
        '--project-root',
        '--sync-target',
      ].includes(arg)
    ) {
      parsed.forward.push(arg, args[index + 1] || '');
      index += 1;
    } else if (arg === '--packaged') {
      parsed.forward.push(arg);
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
    `${arg} has been removed: AlembicPlugin watch mode does not manage the current Codex MCP process lifecycle. ` +
      'It only serializes cache reloads; restart Codex itself if the current transport is closed.'
  );
}

function printHelp() {
  process.stdout.write(`Watch and reload the installed Alembic Codex plugin for local development.

Usage:
  node scripts/dev-watch-codex-plugin.mjs [options]

Behavior:
  Polls Alembic runtime/plugin inputs and runs the canonical
  dev:codex-plugin:reload command after changes. Watch mode is not a separate
  refresh strategy; it serializes canonical cache reloads so the next fresh MCP
  startup uses the latest build. It never restarts the current Codex MCP transport.

Options:
  --once                 Run one refresh and exit.
  --no-initial           Do not refresh immediately when the watcher starts.
  --debounce-ms <ms>     Delay after a file change before refreshing, defaults to 1000.
  --poll-ms <ms>         File snapshot polling interval, defaults to 1500.
  --project-root <path>  Forward project root to the refresh probe.
  --codex-home <path>    Forward CODEX_HOME override.
  --sync-target <path>   Forward extra plugin cache target.
  --probe-target <path>  Forward installed plugin cache probe target.
  --report-path <path>   Forward and read JSON report path.
  --packaged             Forward packaged runtime mode to the probe.
  -h, --help             Show this help.
`);
}
