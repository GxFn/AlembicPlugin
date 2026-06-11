#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pluginRoot = join(root, 'plugins', 'alembic-codex');
const startupPath = join(pluginRoot, 'bin', 'alembic-codex-start.mjs');
const runtimePackageName = '@gxfn/alembic-codex-runtime';
const runtimeVersion = readJson(
  join(root, 'packages', 'alembic-codex-runtime', 'package.json')
).version;
const runtimeSpecifier = `${runtimePackageName}@${runtimeVersion}`;
const keepTmp = process.argv.includes('--keep') || process.env.KEEP_STARTUP_PROBE_TMP === '1';
const tmpRoot = mkdtempSync(join(tmpdir(), 'alembic-codex-startup-probe-'));
const binDir = join(tmpRoot, 'bin');
mkdirSync(binDir, { recursive: true });
const fakeNpmPath = writeFakeNpm(binDir);
const baseEnv = {
  ...process.env,
  ALEMBIC_CODEX_NPM_COMMAND: 'npm',
  ALEMBIC_CODEX_START_TRACE: '1',
  PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
};

try {
  const firstRun = probeFirstRunAndCachedReuse();
  const versionReplacement = probeVersionReplacement();
  const staleLock = probeStaleLockRecovery();
  const failures = probeFailureBranches();
  const concurrency = await probeConcurrency();

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        runtimeSpecifier,
        fakeNpm: fakeNpmPath,
        firstRunInstall: firstRun.firstRun,
        secondRunCached: firstRun.secondRun,
        networkDisabledCached: firstRun.offlineRun,
        versionMismatchReplacement: versionReplacement,
        staleLock,
        failureBranches: failures,
        lockConcurrency: concurrency,
      },
      null,
      2
    )}\n`
  );
} finally {
  if (keepTmp) {
    process.stderr.write(`Startup probe temp kept at ${tmpRoot}\n`);
  } else {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function probeFirstRunAndCachedReuse() {
  const cacheDir = join(tmpRoot, 'first-run-cache');
  const logPath = join(tmpRoot, 'first-run-npm.jsonl');
  const first = runStartup({
    args: ['--', '--first-run'],
    env: { ...baseEnv, ALEMBIC_CODEX_RUNTIME_CACHE_DIR: cacheDir, FAKE_NPM_LOG: logPath },
  });
  assertSuccess(first, 'first-run install');
  const firstRuntime = parseRuntimeOutput(first.stdout, 'first-run install');
  assert(firstRuntime.version === runtimeVersion, 'first-run runtime version mismatch');
  assert(installCount(logPath) === 1, 'first-run should install exactly once');

  const second = runStartup({
    args: ['--', '--second-run'],
    env: { ...baseEnv, ALEMBIC_CODEX_RUNTIME_CACHE_DIR: cacheDir, FAKE_NPM_LOG: logPath },
  });
  assertSuccess(second, 'second-run cached reuse');
  assert(installCount(logPath) === 1, 'second-run should not reinstall');

  const offline = runStartup({
    args: ['--', '--offline-run'],
    env: {
      ...baseEnv,
      ALEMBIC_CODEX_NPM_COMMAND: join(tmpRoot, 'missing-npm'),
      ALEMBIC_CODEX_RUNTIME_CACHE_DIR: cacheDir,
      ALEMBIC_CODEX_RUNTIME_OFFLINE: '1',
      FAKE_NPM_LOG: logPath,
    },
  });
  assertSuccess(offline, 'network-disabled cached startup');
  assert(installCount(logPath) === 1, 'offline cached run should not touch npm');

  return {
    firstRun: 'passed',
    secondRun: 'passed',
    offlineRun: 'passed',
  };
}

function probeVersionReplacement() {
  const cacheDir = join(tmpRoot, 'version-replacement-cache');
  const logPath = join(tmpRoot, 'version-replacement-npm.jsonl');
  writeCachedRuntime({ cacheDir, version: '0.1.0' });

  const result = runStartup({
    args: ['--', '--replacement-run'],
    env: { ...baseEnv, ALEMBIC_CODEX_RUNTIME_CACHE_DIR: cacheDir, FAKE_NPM_LOG: logPath },
  });
  assertSuccess(result, 'version mismatch replacement');
  const runtime = parseRuntimeOutput(result.stdout, 'version mismatch replacement');
  assert(runtime.version === runtimeVersion, 'replacement did not install pinned runtime');
  assert(installCount(logPath) === 1, 'version mismatch should trigger one replacement install');
  return 'passed';
}

function probeStaleLockRecovery() {
  const cacheDir = join(tmpRoot, 'stale-lock-cache');
  const logPath = join(tmpRoot, 'stale-lock-npm.jsonl');
  const lockDir = join(cacheDir, '.install.lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, 'owner.json'),
    `${JSON.stringify(
      {
        pid: 111111,
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
        acquiredAtMs: Date.now() - 60_000,
        source: 'probe-stale-lock',
      },
      null,
      2
    )}\n`
  );

  const result = runStartup({
    args: ['--', '--stale-lock-run'],
    env: {
      ...baseEnv,
      ALEMBIC_CODEX_LOCK_STALE_MS: '10',
      ALEMBIC_CODEX_RUNTIME_CACHE_DIR: cacheDir,
      FAKE_NPM_LOG: logPath,
    },
  });
  assertSuccess(result, 'stale lock recovery');
  assert(
    result.stderr.includes('runtime-lock-stale-removed'),
    'stale lock probe should report stale lock removal'
  );
  return 'passed';
}

function probeFailureBranches() {
  return {
    npmMissing: expectFailure({
      label: 'npm missing',
      code: 'ALEMBIC_CODEX_NPM_MISSING',
      env: {
        ...baseEnv,
        ALEMBIC_CODEX_NPM_COMMAND: join(tmpRoot, 'missing-npm'),
        ALEMBIC_CODEX_RUNTIME_CACHE_DIR: join(tmpRoot, 'npm-missing-cache'),
      },
    }),
    cacheNotWritable: expectFailure({
      label: 'cache not writable',
      code: 'ALEMBIC_CODEX_RUNTIME_CACHE_NOT_WRITABLE',
      before() {
        writeFileSync(join(tmpRoot, 'cache-file'), 'not a directory\n');
      },
      env: {
        ...baseEnv,
        ALEMBIC_CODEX_RUNTIME_CACHE_DIR: join(tmpRoot, 'cache-file'),
      },
    }),
    installFailed: expectFailure({
      label: 'install failed',
      code: 'ALEMBIC_CODEX_RUNTIME_INSTALL_FAILED',
      env: {
        ...baseEnv,
        ALEMBIC_CODEX_RUNTIME_CACHE_DIR: join(tmpRoot, 'install-failed-cache'),
        FAKE_NPM_FAIL: '1',
      },
    }),
    versionMismatchAfterInstall: expectFailure({
      label: 'version mismatch after install',
      code: 'ALEMBIC_CODEX_RUNTIME_VERSION_MISMATCH_AFTER_INSTALL',
      env: {
        ...baseEnv,
        ALEMBIC_CODEX_RUNTIME_CACHE_DIR: join(tmpRoot, 'post-install-mismatch-cache'),
        FAKE_RUNTIME_VERSION: '0.1.0',
      },
    }),
    entrypointMissing: expectFailure({
      label: 'entrypoint missing',
      code: 'ALEMBIC_CODEX_RUNTIME_ENTRYPOINT_MISSING',
      env: {
        ...baseEnv,
        ALEMBIC_CODEX_RUNTIME_CACHE_DIR: join(tmpRoot, 'entrypoint-missing-cache'),
        FAKE_RUNTIME_ENTRYPOINT_MISSING: '1',
      },
    }),
    lockTimeout: expectFailure({
      label: 'lock timeout',
      code: 'ALEMBIC_CODEX_RUNTIME_LOCK_TIMEOUT',
      before() {
        const cacheDir = join(tmpRoot, 'lock-timeout-cache');
        const lockDir = join(cacheDir, '.install.lock');
        mkdirSync(lockDir, { recursive: true });
        writeFileSync(
          join(lockDir, 'owner.json'),
          `${JSON.stringify(
            {
              pid: 222222,
              acquiredAt: new Date().toISOString(),
              acquiredAtMs: Date.now(),
              source: 'probe-lock-timeout',
            },
            null,
            2
          )}\n`
        );
      },
      env: {
        ...baseEnv,
        ALEMBIC_CODEX_LOCK_STALE_MS: '60000',
        ALEMBIC_CODEX_LOCK_TIMEOUT_MS: '50',
        ALEMBIC_CODEX_RUNTIME_CACHE_DIR: join(tmpRoot, 'lock-timeout-cache'),
      },
    }),
  };
}

async function probeConcurrency() {
  const cacheDir = join(tmpRoot, 'concurrency-cache');
  const logPath = join(tmpRoot, 'concurrency-npm.jsonl');
  const env = {
    ...baseEnv,
    ALEMBIC_CODEX_RUNTIME_CACHE_DIR: cacheDir,
    FAKE_NPM_LOG: logPath,
    FAKE_NPM_SLOW_MS: '400',
  };
  const [first, second] = await Promise.all([
    runStartupAsync({ args: ['--', '--concurrency-a'], env }),
    runStartupAsync({ args: ['--', '--concurrency-b'], env }),
  ]);
  assertSuccess(first, 'concurrency first startup');
  assertSuccess(second, 'concurrency second startup');
  assert(installCount(logPath) === 1, 'concurrent startup should install exactly once');
  return 'passed';
}

function runStartup({ args = [], env }) {
  return spawnSync(process.execPath, [startupPath, ...args], {
    cwd: pluginRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function runStartupAsync({ args = [], env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [startupPath, ...args], {
      cwd: pluginRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (status, signal) => {
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
}

function expectFailure({ label, code, env, before }) {
  before?.();
  const result = runStartup({ env });
  assert(result.status !== 0, `${label} should fail`);
  assert(
    result.stderr.includes(`"code": "${code}"`),
    `${label} should report ${code}\n${result.stderr}`
  );
  return 'passed';
}

function assertSuccess(result, label) {
  assert(
    result.status === 0,
    `${label} failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function parseRuntimeOutput(stdout, label) {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert(lines.length > 0, `${label} emitted no runtime stdout`);
  return JSON.parse(lines[lines.length - 1]);
}

function installCount(logPath) {
  if (!existsSync(logPath)) {
    return 0;
  }
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0).length;
}

function writeCachedRuntime({ cacheDir, version }) {
  const packageRoot = join(
    cacheDir,
    'runtime-install',
    'node_modules',
    '@gxfn',
    'alembic-codex-runtime'
  );
  mkdirSync(join(packageRoot, 'dist', 'bin'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: runtimePackageName,
        version,
        bin: { 'alembic-codex-mcp': 'dist/bin/codex-mcp.js' },
      },
      null,
      2
    )}\n`
  );
  writeRuntimeEntrypoint(join(packageRoot, 'dist', 'bin', 'codex-mcp.js'), version);
}

function writeFakeNpm(targetDir) {
  const npmPath = join(targetDir, 'npm');
  writeFileSync(
    npmPath,
    `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('10.99.0\\n');
  process.exit(0);
}
if (process.env.FAKE_NPM_FAIL === '1') {
  process.stderr.write('fake npm package install failure\\n');
  process.exit(42);
}
if (process.env.FAKE_NPM_LOG) {
  appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ pid: process.pid, args }) + '\\n');
}
const slowMs = Number.parseInt(process.env.FAKE_NPM_SLOW_MS || '0', 10);
if (Number.isFinite(slowMs) && slowMs > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slowMs);
}
const prefixIndex = args.indexOf('--prefix');
const prefix = prefixIndex >= 0 ? args[prefixIndex + 1] : process.cwd();
const specifier = args[args.length - 1];
const version = process.env.FAKE_RUNTIME_VERSION || specifier.slice(specifier.lastIndexOf('@') + 1);
const packageRoot = join(prefix, 'node_modules', '@gxfn', 'alembic-codex-runtime');
mkdirSync(join(packageRoot, 'dist', 'bin'), { recursive: true });
writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
  name: '@gxfn/alembic-codex-runtime',
  version,
  bin: { 'alembic-codex-mcp': 'dist/bin/codex-mcp.js' }
}, null, 2) + '\\n');
if (process.env.FAKE_RUNTIME_ENTRYPOINT_MISSING !== '1') {
  writeFileSync(join(packageRoot, 'dist', 'bin', 'codex-mcp.js'), '#!/usr/bin/env node\\nprocess.stdout.write(JSON.stringify({ ok: true, source: "fake-runtime", version: ' + JSON.stringify(version) + ', args: process.argv.slice(2), cache: process.env.ALEMBIC_CODEX_RUNTIME_CACHE_DIR || null }) + "\\\\n");\\n');
}
process.stdout.write('fake npm installed ' + specifier + '\\n');
`,
    { mode: 0o755 }
  );
  chmodSync(npmPath, 0o755);
  return npmPath;
}

function writeRuntimeEntrypoint(path, version) {
  writeFileSync(
    path,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  ok: true,
  source: 'cached-runtime',
  version: ${JSON.stringify(version)},
  args: process.argv.slice(2),
  cache: process.env.ALEMBIC_CODEX_RUNTIME_CACHE_DIR || null
}) + '\\n');
`
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
