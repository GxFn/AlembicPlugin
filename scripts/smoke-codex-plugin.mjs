#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JobStore } from '@alembic/core/daemon';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(import.meta.dirname, '..');
const shouldRunDaemon = process.argv.includes('--daemon');
const shouldRunStdio = !process.argv.includes('--no-stdio');
const keepTmp = process.argv.includes('--keep') || process.env.KEEP_SMOKE_TMP === '1';
const tmpRoot = mkdtempSync(join(tmpdir(), 'alembic-codex-smoke-'));
const packDir = join(tmpRoot, 'pack');
const extractDir = join(tmpRoot, 'extract');
const runtimePackageDir = join(tmpRoot, 'runtime-package');
const npmCacheDir = join(tmpRoot, 'npm-cache');
const projectRoot = join(tmpRoot, 'project');
const stdioProjectRoot = join(tmpRoot, 'stdio-project');
const alembicHome = join(tmpRoot, 'home');
const stdioAlembicHome = join(tmpRoot, 'stdio-home');
mkdirSync(packDir, { recursive: true });
mkdirSync(extractDir, { recursive: true });
mkdirSync(runtimePackageDir, { recursive: true });
mkdirSync(npmCacheDir, { recursive: true });
mkdirSync(projectRoot, { recursive: true });
mkdirSync(stdioProjectRoot, { recursive: true });
mkdirSync(alembicHome, { recursive: true });
mkdirSync(stdioAlembicHome, { recursive: true });
writeFileSync(
  join(projectRoot, 'package.json'),
  '{"name":"codex-smoke-project","type":"module"}\n'
);
writeFileSync(join(projectRoot, 'index.js'), 'export const smoke = true;\n');
writeFileSync(
  join(stdioProjectRoot, 'package.json'),
  '{"name":"codex-stdio-smoke-project","type":"module"}\n'
);
writeFileSync(join(stdioProjectRoot, 'index.js'), 'export const stdioSmoke = true;\n');

const previousEnv = {
  ALEMBIC_PLUGIN_HOST: process.env.ALEMBIC_PLUGIN_HOST,
  ALEMBIC_CODEX_PLUGIN_ROOT: process.env.ALEMBIC_CODEX_PLUGIN_ROOT,
  ALEMBIC_HOME: process.env.ALEMBIC_HOME,
  ALEMBIC_RUNTIME_MODE: process.env.ALEMBIC_RUNTIME_MODE,
  ALEMBIC_PROJECT_DIR: process.env.ALEMBIC_PROJECT_DIR,
  CODEX_WORKSPACE_DIR: process.env.CODEX_WORKSPACE_DIR,
};

let server = null;

try {
  const packageJson = readJson(join(root, 'package.json'));
  const runtimePackage = readJson(join(root, 'packages', 'alembic-runtime', 'package.json'));
  const runtimeSpecifier = `${runtimePackage.name}@${runtimePackage.version}`;
  const runtimePackageBoundary = verifyPreparedRuntimePackageBoundary({
    outputRoot: runtimePackageDir,
    runtimePackage,
    runtimeSpecifier,
  });
  assert(
    existsSync(join(root, 'dist', 'bin', 'host-mcp.js')),
    'dist/bin/host-mcp.js missing; run npm run build first'
  );

  const pack = run('npm', ['pack', '--json', '--pack-destination', packDir, '--ignore-scripts'], {
    cwd: root,
    env: { ...process.env, HUSKY: '0', npm_config_cache: npmCacheDir },
  });
  const packInfo = parseNpmPackJson(pack.stdout)[0];
  const tarball = join(packDir, packInfo.filename);
  assert(existsSync(tarball), `npm pack did not create ${tarball}`);

  const listing = run('tar', ['-tzf', tarball]).stdout.split('\n').filter(Boolean);
  for (const required of requiredPackageFiles()) {
    assert(listing.includes(required), `packed tarball missing ${required}`);
  }
  assertForbiddenPackageFiles(listing);

  run('tar', ['-xzf', tarball, '-C', extractDir]);
  const packageRoot = join(extractDir, 'package');
  const repoNodeModules = join(root, 'node_modules');
  if (existsSync(repoNodeModules) && !existsSync(join(packageRoot, 'node_modules'))) {
    symlinkSync(repoNodeModules, join(packageRoot, 'node_modules'), 'dir');
  }

  const installedPlugin = simulateMarketplaceInstall({ packageRoot, runtimeSpecifier });
  const shellDryRun = runStartupDryRun(installedPlugin.installedRoot, runtimeSpecifier);
  const startupRuntime = verifyStartupRuntimeProbe();

  process.env.ALEMBIC_HOME = alembicHome;
  process.env.ALEMBIC_PLUGIN_HOST = 'codex';
  process.env.ALEMBIC_CODEX_PLUGIN_ROOT = installedPlugin.installedRoot;
  process.env.ALEMBIC_RUNTIME_MODE = 'plugin';
  process.env.ALEMBIC_PROJECT_DIR = projectRoot;
  process.env.CODEX_WORKSPACE_DIR = projectRoot;
  process.env.ALEMBIC_QUIET = '1';

  const { HostMcpServer } = await import(
    pathToFileURL(join(packageRoot, 'dist', 'lib', 'runtime', 'mcp', 'HostMcpServer.js')).href
  );
  server = new HostMcpServer({ projectRoot, waitUntilReadyMs: 10000 });

  const diagnostics = await server.handleToolCall('alembic_status', { aspect: 'runtime' });
  assertResult(diagnostics, 'diagnostics');
  assert(
    diagnostics.data?.package?.pinnedSpecifier === runtimeSpecifier,
    'diagnostics runtime package identity mismatch'
  );
  assert(
    diagnostics.data?.package?.runtimeSpecifier === runtimeSpecifier,
    'diagnostics runtime specifier mismatch'
  );
  assert(diagnostics.data?.plugin?.ok === true, 'diagnostics plugin checks did not pass');
  assert(diagnostics.data?.runtimeIdentity?.mode === 'plugin', 'diagnostics runtime mode mismatch');
  assert(
    diagnostics.data?.primaryAction?.tool === 'alembic_status',
    'diagnostics should point healthy installs to status'
  );

  const beforeStatus = await server.handleToolCall('alembic_status', {});
  assertResult(beforeStatus, 'status before init');
  assert(
    beforeStatus.data?.initialized === false,
    'fresh smoke workspace should start uninitialized'
  );
  assert(
    beforeStatus.data?.onboarding?.state === 'needs_init',
    'fresh smoke workspace should recommend initialization'
  );

  const init = await server.handleToolCall('alembic_init', {});
  assertResult(init, 'codex init');
  assert(init.data?.status?.initialized === true, 'codex init did not produce initialized status');

  const afterStatus = await server.handleToolCall('alembic_status', {});
  assertResult(afterStatus, 'status after init');
  assert(afterStatus.data?.initialized === true, 'status after init should be initialized');
  assert(afterStatus.data?.workspace?.ghost === true, 'codex init should default to Ghost mode');

  const store = new JobStore({ projectRoot });
  const localJob = store.create({ kind: 'rescan', request: { reason: 'smoke' }, source: 'codex' });
  const job = await server.handleToolCall('alembic_job', { jobId: localJob.id });
  assertResult(job, 'local job lookup');
  assert(job.data?.job?.id === localJob.id, 'local job lookup returned the wrong job');

  let stdio = 'skipped';
  if (shouldRunStdio) {
    await runStdioSmoke({
      packageRoot,
      runtimeSpecifier,
      pluginRoot: installedPlugin.installedRoot,
      projectRoot: stdioProjectRoot,
      alembicHome: stdioAlembicHome,
    });
    stdio = 'passed';
  }

  let daemon = null;
  let dashboardHandoff = 'skipped';
  let recovery = 'skipped';
  if (shouldRunDaemon) {
    const dashboard = await server.handleToolCall('alembic_dashboard', {});
    assert(
      dashboard?.success === false && !dashboard?.data?.dashboardUrl,
      'dashboard handoff should fail closed when no local Alembic Dashboard daemon is available'
    );
    dashboardHandoff = 'failed-closed';

    const interruptedJob = store.create({
      kind: 'bootstrap',
      request: { reason: 'daemon-recovery-smoke' },
      source: 'codex',
    });
    store.markRunning(interruptedJob.id);

    daemon = await server.supervisor.ensure({ projectRoot, waitUntilReadyMs: 10000 });
    assert(daemon.ready === true, 'daemon recovery smoke did not start runtime');
    const recoveredJob = await server.handleToolCall('alembic_job', {
      jobId: interruptedJob.id,
    });
    assertResult(recoveredJob, 'daemon recovery job lookup');
    assert(
      recoveredJob.data?.job?.status === 'failed',
      'daemon recovery smoke did not fail interrupted job'
    );
    assert(
      recoveredJob.data?.job?.error?.code === 'DAEMON_RESTARTED',
      'daemon recovery smoke did not record DAEMON_RESTARTED'
    );
    recovery = 'passed';
    await server.handleToolCall('alembic_runtime', { action: 'stop' });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        package: packInfo.filename,
        packageVersion: packageJson.version,
        runtimeSpecifier,
        runtimePackageBoundary,
        startupRuntime,
        install: 'passed',
        shellBootstrap:
          shellDryRun.runtimePackage?.specifier === runtimeSpecifier ? 'passed' : 'failed',
        stdio,
        recovery,
        daemon: shouldRunDaemon ? summarizeSmokeDaemon(daemon) : 'skipped',
        dashboardHandoff,
      },
      null,
      2
    )}\n`
  );
} finally {
  if (server && shouldRunDaemon) {
    try {
      await server.handleToolCall('alembic_runtime', { action: 'stop' });
    } catch {
      /* best effort */
    }
  }
  restoreEnv(previousEnv);
  if (!keepTmp) {
    rmSync(tmpRoot, { recursive: true, force: true });
  } else {
    console.error(`Smoke temp kept at ${tmpRoot}`);
  }
}

function requiredPackageFiles() {
  return [
    'package/.agents/plugins/marketplace.json',
    'package/dist/bin/host-mcp.js',
    'package/dist/bin/daemon-server.js',
    'package/dist/lib/runtime/mcp/HostMcpServer.js',
    'package/packages/alembic-runtime/package.json',
    'package/plugins/alembic-codex/.codex-plugin/plugin.json',
    'package/plugins/alembic-codex/.agents/plugins/marketplace.json',
    'package/plugins/alembic-codex/.mcp.json',
    'package/plugins/alembic-codex/bin/alembic-start.mjs',
    'package/plugins/alembic-codex/RELEASE-PLAYBOOK.md',
    'package/plugins/alembic-codex/README.md',
    'package/plugins/alembic-codex/README.zh-CN.md',
    'package/plugins/alembic-codex/assets/alembic-codex-status.svg',
    'package/plugins/alembic-codex/skills/alembic/SKILL.md',
    'package/scripts/verify-codex-plugin.mjs',
    'package/scripts/verify-plugin-distribution.mjs',
    'package/scripts/smoke-codex-plugin.mjs',
    'package/scripts/probe-codex-plugin-startup-runtime.mjs',
    'package/scripts/prepare-codex-plugin-runtime.mjs',
    'package/scripts/release-codex-plugin.mjs',
    'package/package.json',
  ];
}

function requiredRuntimePackageFiles() {
  return [
    'dist/bin/host-mcp.js',
    'dist/bin/daemon-server.js',
    'dist/lib/runtime/mcp/HostMcpServer.js',
    '.alembic-runtime-boundary.json',
  ];
}

function verifyPreparedRuntimePackageBoundary({ outputRoot, runtimePackage, runtimeSpecifier }) {
  run(
    process.execPath,
    [join(root, 'scripts', 'prepare-codex-runtime-package.mjs'), '--output', outputRoot],
    {
      cwd: root,
    }
  );
  const manifest = readJson(join(outputRoot, 'package.json'));
  assert(manifest.name === runtimePackage.name, 'prepared runtime package name mismatch');
  assert(manifest.version === runtimePackage.version, 'prepared runtime package version mismatch');
  assert(
    `${manifest.name}@${manifest.version}` === runtimeSpecifier,
    'prepared runtime package specifier mismatch'
  );
  assert(
    manifest.bin?.['alembic-codex-mcp'] === 'dist/bin/host-mcp.js',
    'prepared runtime package MCP bin mismatch'
  );
  for (const required of requiredRuntimePackageFiles()) {
    assert(existsSync(join(outputRoot, required)), `prepared runtime package missing ${required}`);
  }
  assert(
    !existsSync(join(outputRoot, 'plugins', 'alembic-codex', 'runtime')),
    'prepared runtime package must not contain old plugin runtime directory'
  );
  assert(
    !existsSync(join(outputRoot, 'plugins', 'alembic-codex', 'runtime.tgz')),
    'prepared runtime package must not contain old plugin runtime tarball'
  );
  return 'passed';
}

function assertForbiddenPackageFiles(listing) {
  for (const entry of listing) {
    assert(
      !entry.startsWith('package/plugins/alembic-codex/runtime/'),
      `packed tarball must not include old plugin runtime directory: ${entry}`
    );
    assert(
      entry !== 'package/plugins/alembic-codex/runtime.tgz',
      'packed tarball must not include old runtime.tgz'
    );
    assert(
      entry !== 'package/plugins/alembic-codex/bin/alembic-codex-mcp-wrapper.mjs',
      'packed tarball must not include old MCP wrapper'
    );
    assert(
      !entry.startsWith('package/plugins/alembic-codex/node_modules/'),
      `packed tarball must not include plugin node_modules: ${entry}`
    );
  }
}

function simulateMarketplaceInstall({ packageRoot, runtimeSpecifier }) {
  const marketplace = readJson(join(packageRoot, '.agents', 'plugins', 'marketplace.json'));
  const entry = Array.isArray(marketplace.plugins)
    ? marketplace.plugins.find((item) => item?.name === 'alembic')
    : null;
  assert(entry, 'marketplace install smoke missing alembic-codex entry');
  assert(entry.source?.source === 'local', 'marketplace install smoke requires local source');
  assert(
    entry.source?.path === './plugins/alembic-codex',
    'marketplace install smoke requires ./plugins/alembic-codex source path'
  );

  const sourceRoot = resolve(packageRoot, entry.source.path);
  const installedRoot = join(packageRoot, '.codex-install-smoke', entry.name);
  cpSync(sourceRoot, installedRoot, { recursive: true });

  const manifest = readJson(join(installedRoot, '.codex-plugin', 'plugin.json'));
  assert(manifest.name === 'alembic', 'installed plugin manifest name mismatch');
  const mcp = readJson(join(installedRoot, '.mcp.json'));
  const args = Array.isArray(mcp.mcpServers?.alembic?.args) ? mcp.mcpServers.alembic.args : [];
  const env = mcp.mcpServers?.alembic?.env || {};
  assert(mcp.mcpServers?.alembic?.command === 'node', 'installed plugin MCP must launch Node');
  assert(
    JSON.stringify(args) === JSON.stringify(['./bin/alembic-start.mjs']),
    'installed plugin MCP shell entry mismatch'
  );
  assert(
    existsSync(join(installedRoot, 'bin', 'alembic-start.mjs')),
    'installed plugin shell startup file missing'
  );
  assert(
    !existsSync(join(installedRoot, 'runtime')),
    'installed plugin must not contain old runtime directory'
  );
  assert(
    !existsSync(join(installedRoot, 'runtime.tgz')),
    'installed plugin must not contain old runtime tarball'
  );
  assert(
    !existsSync(join(installedRoot, 'node_modules')),
    'installed plugin must not contain node_modules'
  );
  assert(
    env.ALEMBIC_CODEX_PLUGIN_ROOT === '.',
    'installed plugin MCP must pass ALEMBIC_CODEX_PLUGIN_ROOT=.'
  );
  assert(
    env.ALEMBIC_RUNTIME_MODE === 'plugin',
    'installed plugin MCP must pass ALEMBIC_RUNTIME_MODE=plugin'
  );
  assert(
    env.ALEMBIC_PLUGIN_HOST === 'codex',
    'installed plugin MCP must pass ALEMBIC_PLUGIN_HOST=codex'
  );
  assert(!env.npm_config_cache, 'installed plugin MCP config must not force npm cache setup');

  const startupSource = readFileSync(join(installedRoot, 'bin', 'alembic-start.mjs'), 'utf8');
  assert(
    startupSource.includes(runtimeSpecifier),
    'installed startup shell does not target the pinned runtime package'
  );
  for (const asset of collectManifestAssets(manifest.interface || {})) {
    assert(existsSync(resolve(installedRoot, asset)), `installed plugin asset missing: ${asset}`);
  }
  for (const skill of [
    'alembic',
    'alembic-create',
    'alembic-guard',
    'alembic-recipes',
    'alembic-structure',
  ]) {
    assert(
      existsSync(join(installedRoot, 'skills', skill, 'SKILL.md')),
      `installed plugin skill missing: ${skill}`
    );
  }

  return { installedRoot };
}

function runStartupDryRun(installedRoot, runtimeSpecifier) {
  const result = run(
    process.execPath,
    [join(installedRoot, 'bin', 'alembic-start.mjs'), '--dry-run'],
    {
      cwd: installedRoot,
    }
  );
  const dryRun = JSON.parse(result.stdout);
  assert(dryRun.ok === true, 'startup dry-run did not report ok=true');
  assert(
    dryRun.runtimePackage?.specifier === runtimeSpecifier,
    'startup dry-run runtime specifier mismatch'
  );
  assert(dryRun.command === process.execPath, 'startup dry-run command must launch Node runtime');
  assert(
    String(dryRun.args?.[0] || '').endsWith('dist/bin/host-mcp.js'),
    'startup dry-run must target the cached runtime MCP entrypoint'
  );
  assert(dryRun.npm?.command === 'npm', 'startup dry-run npm command mismatch');
  assert(
    Array.isArray(dryRun.npm?.args) && dryRun.npm.args.includes(runtimeSpecifier),
    'startup dry-run npm args must install the pinned runtime'
  );
  assert(
    dryRun.runtimeCache?.lockDir?.endsWith('.install.lock'),
    'startup dry-run must expose a startup/install lock'
  );
  return dryRun;
}

function verifyStartupRuntimeProbe() {
  const result = run(
    process.execPath,
    [join(root, 'scripts', 'probe-codex-plugin-startup-runtime.mjs')],
    {
      cwd: root,
    }
  );
  const summary = JSON.parse(result.stdout);
  assert(summary.ok === true, 'startup runtime probe did not report ok=true');
  assert(summary.runtimeSpecifier, 'startup runtime probe did not report runtimeSpecifier');
  assert(summary.firstRunInstall === 'passed', 'startup runtime first-run probe failed');
  assert(summary.secondRunCached === 'passed', 'startup runtime cached probe failed');
  assert(summary.networkDisabledCached === 'passed', 'startup runtime offline cached probe failed');
  assert(
    summary.versionMismatchReplacement === 'passed',
    'startup runtime version replacement probe failed'
  );
  assert(summary.lockConcurrency === 'passed', 'startup runtime concurrency probe failed');
  return 'passed';
}

async function runStdioSmoke({
  packageRoot,
  runtimeSpecifier,
  pluginRoot,
  projectRoot,
  alembicHome,
}) {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(packageRoot, 'dist', 'bin', 'host-mcp.js')],
    cwd: pluginRoot,
    env: {
      ALEMBIC_CODEX_ENABLE_ADMIN: '0',
      ALEMBIC_CODEX_PLUGIN_ROOT: pluginRoot,
      ALEMBIC_HOME: alembicHome,
      ALEMBIC_MCP_TIER: 'agent',
      ALEMBIC_PLUGIN_HOST: 'codex',
      ALEMBIC_PROJECT_DIR: projectRoot,
      ALEMBIC_QUIET: '1',
      ALEMBIC_RUNTIME_MODE: 'plugin',
      CODEX_WORKSPACE_DIR: projectRoot,
      PATH: process.env.PATH || '',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));

  const client = new Client({ name: 'alembic-codex-smoke', version: '0.0.0' });
  try {
    await withTimeout(
      client.connect(transport, { timeout: 5000 }),
      7000,
      () => `MCP stdio connect timed out\n${stderr.join('')}`
    );
    const toolsResult = await withTimeout(
      client.listTools(undefined, { timeout: 5000 }),
      7000,
      () => `MCP tools/list timed out\n${stderr.join('')}`
    );
    const toolNames = new Set(toolsResult.tools.map((tool) => tool.name));
    for (const required of [
      'alembic_status',
      'alembic_init',
      'alembic_dashboard',
      'alembic_job',
      'alembic_submit_knowledge',
      'alembic_bootstrap',
      'alembic_rescan',
      'alembic_dimension_complete',
    ]) {
      assert(toolNames.has(required), `MCP stdio tools/list missing ${required}`);
    }
    // MTC: retired/merged tool names must be ABSENT from the live cold-start surface.
    for (const retired of [
      'alembic_mcp_status',
      'alembic_codex_diagnostics',
      'alembic_health',
      'alembic_mcp_init',
      'alembic_codex_dashboard',
      'alembic_mcp_bootstrap_job',
      'alembic_mcp_rescan_job',
      'alembic_codex_job',
      'alembic_codex_stop',
      'alembic_codex_cleanup',
      'alembic_work_start',
      'alembic_work_finish',
      'alembic_guard',
    ]) {
      assert(!toolNames.has(retired), `MCP stdio tools/list still exposes retired ${retired}`);
    }

    const diagnostics = await callStdioJsonTool(
      client,
      'alembic_status',
      { aspect: 'runtime' },
      stderr
    );
    assertResult(diagnostics, 'MCP stdio diagnostics');
    assert(
      diagnostics.package?.pinnedSpecifier === runtimeSpecifier,
      'MCP stdio diagnostics runtime package identity mismatch'
    );
    assert(
      diagnostics.package?.runtimeSpecifier === runtimeSpecifier,
      'MCP stdio diagnostics runtime specifier mismatch'
    );
    assert(diagnostics.plugin?.ok === true, 'MCP stdio diagnostics plugin checks did not pass');

    const beforeStatus = await callStdioJsonTool(client, 'alembic_status', {}, stderr);
    assertResult(beforeStatus, 'MCP stdio status before init');
    assert(
      beforeStatus.initialized === false,
      'MCP stdio fresh workspace should start uninitialized'
    );

    const init = await callStdioJsonTool(client, 'alembic_init', {}, stderr);
    assertResult(init, 'MCP stdio codex init');
    assert(
      init.statusSnapshot?.initialized === true,
      'MCP stdio codex init did not produce initialized status'
    );
  } finally {
    await closeMcpClient(client, stderr, 'MCP stdio');
  }
}

function collectManifestAssets(iface) {
  return [
    iface.composerIcon,
    iface.logo,
    ...(Array.isArray(iface.screenshots) ? iface.screenshots : []),
  ].filter((asset) => typeof asset === 'string' && asset.length > 0);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`
    );
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseNpmPackJson(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) {
    throw new Error(`npm pack did not emit JSON output:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertResult(result, label) {
  assert(result && typeof result === 'object', `${label} did not return an object`);
  assert(
    result.success === true || result.ok === true,
    `${label} failed: ${result.message || result.summary || JSON.stringify(result)}`
  );
}

function summarizeSmokeDaemon(status) {
  if (!status || typeof status !== 'object') {
    return null;
  }
  return {
    ready: status.ready === true,
    url: status.state?.url || null,
    dashboardUrl: status.state?.dashboardUrl || null,
  };
}

async function closeMcpClient(client, stderr, label) {
  try {
    await client.close();
  } catch (error) {
    const connectionClosed =
      error?.code === -32000 || /connection closed/i.test(String(error?.message || error));
    if (connectionClosed) {
      return;
    }
    throw new Error(`${label} close failed: ${error?.message || error}\n${stderr.join('')}`);
  }
}

async function callStdioJsonTool(client, name, args, stderr) {
  const result = await withTimeout(
    client.callTool({ name, arguments: args }, undefined, { timeout: 5000 }),
    7000,
    () => `MCP stdio ${name} timed out\n${stderr.join('')}`
  );
  assert(!result.isError, `MCP stdio ${name} returned isError\n${JSON.stringify(result)}`);
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert(typeof text === 'string' && text.length > 0, `MCP stdio ${name} returned no text`);
  return JSON.parse(text);
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message())), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function restoreEnv(env) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
