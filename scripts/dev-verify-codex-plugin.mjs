#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(import.meta.dirname, '..');
const options = parseArgs(process.argv.slice(2));
const tmpRoot = mkdtempSync(join(tmpdir(), 'alembic-codex-dev-verify-'));
const report = {
  ok: false,
  mode: options.localMcp ? 'local-mcp' : 'packaged-shell',
  projectRoot: options.projectRoot,
  readbackContract: {
    blockedEffectiveIdentityFallbacks: [
      'saved-project-root-effective-identity',
      'runtime-control-selected-active-effective-identity',
      'local-jobstore-default-effective-identity',
    ],
    failureEnvelopePath: 'projectRuntime.failureEnvelopes',
    sourcePolicyPath: 'projectRuntime.sourcePolicy',
    diagnosticsTool: 'alembic_status',
    statusTool: 'alembic_status',
  },
  steps: [],
  synced: null,
  probes: [],
};

try {
  if (!options.probeOnly) {
    if (!options.skipBuild) {
      runStep('build', 'npm', ['run', 'build']);
    }
    if (!options.skipTests) {
      runStep('unit project-root and init gates', 'npx', [
        'vitest',
        'run',
        'test/unit/CodexProjectRootResolver.test.ts',
        'test/unit/HostMcpServer.test.ts',
        'test/unit/CodexToolPolicy.test.ts',
      ]);
    }
    if (!options.skipPrepare) {
      runStep('prepare codex plugin shell', 'npm', ['run', 'prepare:codex-plugin-runtime']);
    }
    if (!options.skipVerify) {
      runStep('verify codex plugin metadata', 'npm', ['run', 'verify:codex-plugin']);
    }
    if (!options.skipSmoke) {
      const smokeArgs = ['run', 'smoke:codex-plugin', '--'];
      runStep('smoke codex plugin', 'npm', smokeArgs);
    }
  }

  if (!options.noSync && !options.probeOnly) {
    report.synced = runSync();
  }

  const targets = options.probeTargets.length > 0 ? options.probeTargets : readSyncedTargets();
  if (targets.length === 0) {
    throw new Error('No installed Alembic Codex plugin cache targets were found to probe.');
  }
  for (const target of targets) {
    report.probes.push(await probeInstalledTarget(target));
  }

  report.ok = true;
  printReport();
} finally {
  if (options.keepTmp) {
    console.error(`Alembic Codex dev verify temp kept at ${tmpRoot}`);
  } else {
    rmSync(tmpRoot, { force: true, recursive: true });
  }
}

function runSync() {
  const args = ['scripts/sync-codex-plugin-cache.mjs', '--clean', '--all-installed'];
  if (options.localMcp) {
    args.push('--local-mcp');
  }
  if (options.codexHome) {
    args.push('--codex-home', options.codexHome);
  }
  for (const target of options.syncTargets) {
    args.push('--target-root', target);
  }
  const result = runStep('sync codex plugin cache', process.execPath, args, { capture: true });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Could not parse sync summary: ${error.message}\n${result.stdout}`);
  }
}

function readSyncedTargets() {
  if (report.synced && Array.isArray(report.synced.targetRoots)) {
    return report.synced.targetRoots;
  }
  const plugin = readJson(join(root, 'plugins', 'alembic-codex', '.codex-plugin', 'plugin.json'));
  const pluginRoot = join(root, 'plugins', 'alembic-codex');
  const pluginNameAliases = [...new Set([plugin.name, basename(pluginRoot)])].filter(Boolean);
  const cacheRoot = resolve(options.codexHome || join(process.env.HOME || '', '.codex'));
  const candidates = [
    join(cacheRoot, 'plugins', 'cache', 'alembic-codex', plugin.name, plugin.version),
    ...pluginNameAliases.map((alias) =>
      join(cacheRoot, 'plugins', 'cache', 'gxfn', alias, plugin.version)
    ),
  ];
  return [...new Set(candidates)].filter((target) => existsSync(join(target, '.mcp.json')));
}

async function probeInstalledTarget(targetRoot) {
  const marker = existsSync(join(targetRoot, '.alembic-dev-refresh.json'))
    ? readJson(join(targetRoot, '.alembic-dev-refresh.json'))
    : null;
  const localProjection = assertLocalProjectionMarker(marker, targetRoot);
  const savedHome = join(tmpRoot, `home-${report.probes.length}`);
  const failedHome = join(tmpRoot, `failed-home-${report.probes.length}`);
  const first = await callMcpStatus(targetRoot, savedHome, { projectRoot: options.projectRoot });
  assertStatusProjectRootReadback(first, targetRoot);
  const diagnostics = await callMcpDiagnostics(targetRoot, savedHome, {
    projectRoot: options.projectRoot,
  });
  assertDiagnosticsProjectRootReadback(diagnostics, targetRoot);
  const runtimeReadback = assertRuntimeReadback(diagnostics, marker, targetRoot);
  const savedData = await callMcpTool(targetRoot, savedHome, 'alembic_status', {});
  const savedResolution = summarizeStatus(savedData);
  assertProbe(
    savedResolution.source !== 'saved-project-root' &&
      savedResolution.projectRoot !== options.projectRoot,
    `Saved projectRoot was unexpectedly reused for ${targetRoot}: ${JSON.stringify({
      statusReadback: savedResolution,
    })}`
  );
  const failClosed = await callMcpTool(targetRoot, failedHome, 'alembic_init', {});
  assertProbe(
    failClosed.ok === false &&
      ['CODEX_PROJECT_ROOT_REJECTED', 'CODEX_PROJECT_ROOT_UNRESOLVED'].includes(
        failClosed.error?.code
      ),
    `Missing projectRoot did not fail closed for ${targetRoot}: ${JSON.stringify(failClosed)}`
  );
  return {
    targetRoot,
    marker,
    explicit: summarizeStatus(first),
    diagnostics: summarizeDiagnostics(diagnostics),
    localProjection,
    runtimeReadback,
    saved: summarizeStatus(savedData),
    failClosed: {
      errorCode: failClosed.error?.code || null,
      needsUserInput: failClosed.needsUserInput === true,
      ok: failClosed.ok,
    },
  };
}

function assertLocalProjectionMarker(marker, targetRoot) {
  const markerRecord = objectFrom(marker);
  const mode = markerRecord?.mode ?? report.mode;
  if (mode !== 'local-mcp') {
    return null;
  }
  assertProbe(markerRecord, `Missing local-mcp refresh marker for ${targetRoot}`);

  const gitHead = readGitHead();
  if (gitHead) {
    assertProbe(
      markerRecord.gitHead === gitHead,
      `Installed cache marker gitHead is stale for ${targetRoot}: expected ${gitHead}, got ${markerRecord.gitHead}`
    );
  }

  const projection = objectFrom(markerRecord.localProjection);
  assertProbe(
    projection,
    `Missing localProjection proof in .alembic-dev-refresh.json for ${targetRoot}`
  );
  assertProbe(
    projection.mode === 'local-dev-direct-dist',
    `Unexpected local projection mode for ${targetRoot}: ${JSON.stringify(projection.mode)}`
  );

  const mcpEntry = objectFrom(projection.mcpEntry);
  assertProbe(
    mcpEntry?.path === markerRecord.localMcpEntry,
    `localProjection mcpEntry does not match localMcpEntry for ${targetRoot}: ${JSON.stringify({
      localMcpEntry: markerRecord.localMcpEntry,
      mcpEntry,
    })}`
  );
  assertProbe(
    mcpEntry?.exists === true &&
      typeof mcpEntry.path === 'string' &&
      typeof mcpEntry.hash === 'string',
    `localProjection mcpEntry is missing or unhashed for ${targetRoot}: ${JSON.stringify(mcpEntry)}`
  );
  assertProbe(
    hashFile(mcpEntry.path) === mcpEntry.hash,
    `localProjection mcpEntry hash no longer matches for ${targetRoot}: ${JSON.stringify(mcpEntry)}`
  );

  const requiredMarkerNames = Array.isArray(projection.requiredMarkerNames)
    ? projection.requiredMarkerNames
    : [];
  for (const markerName of [
    'releasedEmptySession',
    'coverageLedgerSeed',
    'noActionableHostAgentWork',
  ]) {
    assertProbe(
      requiredMarkerNames.includes(markerName),
      `localProjection marker list is missing ${markerName} for ${targetRoot}: ${JSON.stringify(requiredMarkerNames)}`
    );
  }
  assertProbe(
    projection.allRequiredMarkersPresent === true,
    `localProjection required markers are not all present for ${targetRoot}: ${JSON.stringify(projection)}`
  );

  const files = Array.isArray(projection.files) ? projection.files : [];
  const summaries = [];
  for (const id of ['knowledge-rescan-runtime', 'knowledge-rescan-source']) {
    const file = files.find((candidate) => candidate?.id === id);
    assertProbe(file, `localProjection is missing ${id} proof for ${targetRoot}`);
    assertProjectionFile(file, targetRoot);
    summaries.push({
      id: file.id,
      kind: file.kind ?? null,
      path: file.path,
      hash: file.hash,
      markers: file.markerStatus,
    });
  }

  return {
    allRequiredMarkersPresent: true,
    gitHead: markerRecord.gitHead ?? null,
    mcpEntry: { path: mcpEntry.path, hash: mcpEntry.hash },
    files: summaries,
  };
}

function assertProjectionFile(file, targetRoot) {
  const markerStatus = objectFrom(file.markerStatus);
  assertProbe(
    file.exists === true && typeof file.hash === 'string',
    `localProjection file is missing or unhashed for ${targetRoot}: ${JSON.stringify(file)}`
  );
  assertProbe(
    hashFile(file.path) === file.hash,
    `localProjection file hash no longer matches for ${targetRoot}: ${JSON.stringify(file)}`
  );
  for (const markerName of [
    'releasedEmptySession',
    'coverageLedgerSeed',
    'noActionableHostAgentWork',
  ]) {
    assertProbe(
      markerStatus?.[markerName] === true,
      `localProjection file ${file.id} is missing marker ${markerName} for ${targetRoot}: ${JSON.stringify(file)}`
    );
  }
  assertProbe(
    file.allRequiredMarkersPresent === true,
    `localProjection file ${file.id} does not have all required markers for ${targetRoot}: ${JSON.stringify(file)}`
  );
}

async function callMcpStatus(targetRoot, alembicHome, args) {
  const result = await callMcpTool(targetRoot, alembicHome, 'alembic_status', args);
  assertProbe(result.ok === true, `alembic_status failed: ${JSON.stringify(result)}`);
  return result;
}

async function callMcpDiagnostics(targetRoot, alembicHome, args) {
  const result = await callMcpTool(targetRoot, alembicHome, 'alembic_status', {
    ...args,
    aspect: 'runtime',
  });
  assertProbe(
    result.ok === true,
    `alembic_status (aspect=runtime) failed: ${JSON.stringify(result)}`
  );
  return result;
}

async function callMcpTool(targetRoot, alembicHome, name, args) {
  const mcp = readJson(join(targetRoot, '.mcp.json'));
  const server = mcp.mcpServers?.alembic;
  if (!server?.command || !Array.isArray(server.args)) {
    throw new Error(`Invalid .mcp.json at ${targetRoot}`);
  }
  const stderr = [];
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: targetRoot,
    env: sanitizeEnv({
      ...process.env,
      ...(server.env || {}),
      ALEMBIC_HOME: alembicHome,
      ALEMBIC_QUIET: '1',
      INIT_CWD: targetRoot,
      PWD: targetRoot,
    }),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: 'alembic-codex-dev-verify', version: '0.0.0' });
  try {
    await withTimeout(
      client.connect(transport, { timeout: options.mcpTimeoutMs }),
      options.mcpTimeoutMs + 2000,
      () => `MCP connect timed out for ${targetRoot}\n${stderr.join('')}`
    );
    const result = await withTimeout(
      client.callTool({ name, arguments: args }, undefined, { timeout: options.mcpTimeoutMs }),
      options.mcpTimeoutMs + 2000,
      () => `MCP ${name} timed out for ${targetRoot}\n${stderr.join('')}`
    );
    if (result.structuredContent && typeof result.structuredContent === 'object') {
      return result.structuredContent;
    }
    const text = result.content?.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string') {
      throw new Error(`MCP ${name} returned no text content\n${JSON.stringify(result)}`);
    }
    return JSON.parse(text);
  } finally {
    await client.close();
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
      npm_config_cache: join(tmpRoot, 'npm-cache'),
    },
  });
  const step = {
    name,
    command: [command, ...args].join(' '),
    durationMs: Date.now() - startedAt,
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

function summarizeStatus(data) {
  const project = objectFrom(data.project);
  const resolution = objectFrom(data.projectRootResolution);
  return {
    ok: data.ok === true,
    projectRoot:
      stringFrom(project?.root) ??
      stringFrom(project?.projectRoot) ??
      stringFrom(data.projectRoot) ??
      stringFrom(resolution?.path) ??
      null,
    initialized: data.initialized,
    source: stringFrom(resolution?.source),
    trust: stringFrom(project?.trust) ?? stringFrom(resolution?.trust),
    rejected:
      typeof project?.trusted === 'boolean'
        ? project.trusted !== true
        : typeof resolution?.rejected === 'boolean'
          ? resolution.rejected
          : null,
    status: stringFrom(data.status),
    trusted:
      typeof project?.trusted === 'boolean'
        ? project.trusted
        : stringFrom(resolution?.trust) === 'trusted',
  };
}

function summarizeDiagnostics(data) {
  const resolution = objectFrom(data.projectRootResolution);
  const runtime = objectFrom(data.projectRuntime);
  const identity = objectFrom(runtime?.identity);
  return {
    ok: data.ok === true,
    projectRoot: stringFrom(resolution?.path) ?? null,
    runtimeProjectRoot: stringFrom(identity?.projectRoot) ?? null,
    source: stringFrom(resolution?.source) ?? null,
    trust: stringFrom(resolution?.trust) ?? null,
  };
}

function assertStatusProjectRootReadback(data, targetRoot) {
  const status = summarizeStatus(data);
  assertProbe(
    status.projectRoot === options.projectRoot,
    `Status project root did not preserve explicit projectRoot for ${targetRoot}: ${JSON.stringify(status)}`
  );
  assertProbe(
    status.trust === 'trusted' && status.trusted === true,
    `Status project root was not trusted for ${targetRoot}: ${JSON.stringify(status)}`
  );
}

function assertDiagnosticsProjectRootReadback(data, targetRoot) {
  const diagnostics = summarizeDiagnostics(data);
  assertProbe(
    diagnostics.projectRoot === options.projectRoot &&
      diagnostics.runtimeProjectRoot === options.projectRoot,
    `Diagnostics project root did not preserve explicit projectRoot for ${targetRoot}: ${JSON.stringify(diagnostics)}`
  );
  assertProbe(
    diagnostics.source === 'explicit-option' && diagnostics.trust === 'trusted',
    `Diagnostics projectRootResolution was not trusted for ${targetRoot}: ${JSON.stringify(diagnostics)}`
  );
}

function assertRuntimeReadback(data, marker, targetRoot) {
  const runtime = objectFrom(data.projectRuntime);
  assertProbe(
    runtime,
    `Missing projectRuntime readback for ${targetRoot}: ${JSON.stringify(data)}`
  );
  const identity = objectFrom(runtime.identity);
  assertProbe(
    identity?.projectRoot === options.projectRoot,
    `projectRuntime identity did not preserve explicit projectRoot for ${targetRoot}: ${JSON.stringify(identity)}`
  );
  assertProbe(
    typeof identity.dataRoot === 'string' && identity.dataRoot.length > 0,
    `projectRuntime identity missing dataRoot for ${targetRoot}: ${JSON.stringify(identity)}`
  );
  assertProbe(
    typeof identity.runtimeDir === 'string' && identity.runtimeDir.length > 0,
    `projectRuntime identity missing runtimeDir for ${targetRoot}: ${JSON.stringify(identity)}`
  );
  assertProbe(
    typeof identity.databasePath === 'string' && identity.databasePath.length > 0,
    `projectRuntime identity missing databasePath for ${targetRoot}: ${JSON.stringify(identity)}`
  );

  const sourcePolicy = objectFrom(runtime.sourcePolicy);
  assertProbe(
    sourcePolicy?.effectiveIdentitySource === 'codex-current-project',
    `projectRuntime sourcePolicy did not keep Codex current project as source for ${targetRoot}: ${JSON.stringify(sourcePolicy)}`
  );
  assertProbe(
    sourcePolicy?.selectedOrActiveCanOverrideEffectiveIdentity === false,
    `selected/active runtime state can override effective identity for ${targetRoot}: ${JSON.stringify(sourcePolicy)}`
  );
  assertProbe(
    sourcePolicy?.runtimeControlSource === 'read-only-diagnostics',
    `runtime control state is not diagnostic-only for ${targetRoot}: ${JSON.stringify(sourcePolicy)}`
  );

  const blockedFallbacks = Array.isArray(runtime.blockedFallbacks) ? runtime.blockedFallbacks : [];
  for (const fallback of report.readbackContract.blockedEffectiveIdentityFallbacks) {
    assertProbe(
      blockedFallbacks.includes(fallback),
      `Missing blocked effective identity fallback ${fallback} for ${targetRoot}: ${JSON.stringify(blockedFallbacks)}`
    );
  }

  const fallbackIsolation = Array.isArray(runtime.fallbackIsolation)
    ? runtime.fallbackIsolation
    : [];
  for (const id of [
    'embedded-plugin-owned-runtime',
    'local-jobstore',
    'runtime-control-selected-active',
    'saved-project-root',
  ]) {
    const item = fallbackIsolation.find((candidate) => candidate?.id === id);
    assertProbe(
      item?.effectiveIdentityAllowed === false && item?.persistenceRootAllowed === false,
      `Fallback isolation ${id} was not blocked for effective identity/persistence in ${targetRoot}: ${JSON.stringify(item)}`
    );
  }

  const requiredServices = Array.isArray(runtime.requiredServices) ? runtime.requiredServices : [];
  const projectIdentity = requiredServices.find(
    (service) => service?.service === 'project-identity'
  );
  assertProbe(
    projectIdentity?.available === true && projectIdentity?.source === 'codex-current-project',
    `project-identity readiness did not come from Codex current project for ${targetRoot}: ${JSON.stringify(requiredServices)}`
  );

  const failureEnvelopes = Array.isArray(runtime.failureEnvelopes)
    ? runtime.failureEnvelopes
    : null;
  assertProbe(
    failureEnvelopes,
    `projectRuntime failureEnvelopes is not an array for ${targetRoot}: ${JSON.stringify(runtime.failureEnvelopes)}`
  );
  for (const envelope of failureEnvelopes) {
    assertProbe(
      typeof envelope?.contractVersion === 'number' &&
        typeof envelope?.reason === 'string' &&
        typeof envelope?.readinessState === 'string',
      `Invalid projectRuntime failure envelope for ${targetRoot}: ${JSON.stringify(envelope)}`
    );
  }

  const entryMode = objectFrom(runtime.entryMode);
  const expectedEntryMode = expectedEntryModeForMarker(marker);
  if (expectedEntryMode) {
    assertProbe(
      entryMode?.mode === expectedEntryMode,
      `Unexpected MCP entry mode for ${targetRoot}: expected ${expectedEntryMode}, got ${JSON.stringify(entryMode)}`
    );
  }

  return {
    blockedFallbacks,
    dataRoot: identity.dataRoot,
    databasePath: identity.databasePath,
    entryMode: entryMode?.mode ?? null,
    expectedEntryMode,
    failureEnvelopeReasons: failureEnvelopes.map((envelope) => envelope.reason),
    fallbackIsolation: fallbackIsolation.map((item) => ({
      effectiveIdentityAllowed: item?.effectiveIdentityAllowed === true,
      id: item?.id ?? null,
      persistenceRootAllowed: item?.persistenceRootAllowed === true,
    })),
    projectRoot: identity.projectRoot,
    readinessState: runtime.readinessState ?? null,
    requiredServices: requiredServices.map((service) => ({
      available: service?.available === true,
      service: service?.service ?? null,
      source: service?.source ?? null,
      state: service?.state ?? null,
    })),
    runtimeDir: identity.runtimeDir,
    sourcePolicy,
  };
}

function expectedEntryModeForMarker(marker) {
  const mode = objectFrom(marker)?.mode ?? report.mode;
  if (mode === 'local-mcp') {
    return 'local-dev-direct-dist';
  }
  if (mode === 'packaged-shell') {
    return 'marketplace-shell';
  }
  return null;
}

function objectFrom(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function stringFrom(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseArgs(args) {
  const parsed = {
    codexHome: '',
    keepTmp: false,
    localMcp: true,
    mcpTimeoutMs: 30000,
    noSync: false,
    probeOnly: false,
    probeTargets: [],
    projectRoot: root,
    reportPath: join(root, 'scratch', 'codex-plugin-dev-verify-report.json'),
    skipBuild: false,
    skipPrepare: false,
    skipSmoke: false,
    skipTests: false,
    skipVerify: false,
    syncTargets: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--codex-home') {
      parsed.codexHome = args[index + 1] || '';
      index += 1;
    } else if (arg === '--keep-tmp') {
      parsed.keepTmp = true;
    } else if (arg === '--packaged') {
      parsed.localMcp = false;
      parsed.mcpTimeoutMs = Math.max(parsed.mcpTimeoutMs, 180000);
    } else if (arg === '--probe-only') {
      parsed.probeOnly = true;
      parsed.noSync = true;
      parsed.skipBuild = true;
      parsed.skipPrepare = true;
      parsed.skipSmoke = true;
      parsed.skipTests = true;
      parsed.skipVerify = true;
    } else if (arg === '--refresh-only') {
      parsed.skipSmoke = true;
      parsed.skipTests = true;
      parsed.skipVerify = true;
    } else if (arg === '--no-sync') {
      parsed.noSync = true;
    } else if (arg === '--skip-build') {
      parsed.skipBuild = true;
    } else if (arg === '--skip-prepare') {
      parsed.skipPrepare = true;
    } else if (arg === '--skip-smoke') {
      parsed.skipSmoke = true;
    } else if (arg === '--skip-tests') {
      parsed.skipTests = true;
    } else if (arg === '--skip-verify') {
      parsed.skipVerify = true;
    } else if (arg === '--with-npx-runtime') {
      // Compatibility no-op: MPB2 smoke proves the shell with dry-run and keeps live install semantics for MPB3.
    } else if (arg === '--project-root') {
      parsed.projectRoot = resolve(args[index + 1] || '');
      index += 1;
    } else if (arg === '--probe-target') {
      parsed.probeTargets.push(resolve(args[index + 1] || ''));
      index += 1;
    } else if (arg === '--report-path') {
      parsed.reportPath = resolve(args[index + 1] || parsed.reportPath);
      index += 1;
    } else if (arg === '--sync-target') {
      parsed.syncTargets.push(resolve(args[index + 1] || ''));
      index += 1;
    } else if (arg === '--mcp-timeout-ms') {
      parsed.mcpTimeoutMs = Number(args[index + 1] || parsed.mcpTimeoutMs);
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

function sanitizeEnv(env) {
  return Object.fromEntries(Object.entries(env).filter((entry) => typeof entry[1] === 'string'));
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

function assertProbe(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function hashFile(path) {
  if (!existsSync(path)) {
    return null;
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readGitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function printReport() {
  mkdirSync(dirname(options.reportPath), { recursive: true });
  writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ ...report, reportPath: options.reportPath }, null, 2)}\n`
  );
}

function printHelp() {
  process.stdout.write(`Run Alembic Codex plugin local development verification.

Usage:
  node scripts/dev-verify-codex-plugin.mjs [options]

Default flow:
  build, run focused unit tests, prepare runtime, verify plugin metadata,
  run smoke without npx runtime, refresh installed Codex plugin caches in local-mcp mode,
  and probe installed MCP projectRoot behavior.

Options:
  --refresh-only          Build, prepare, refresh installed cache, and probe. Skip tests/verify/smoke.
  --probe-only            Probe existing installed cache only.
  --packaged              Probe installed cache through packaged runtime wrapper instead of local dist.
  --with-npx-runtime      Include smoke npx/runtime startup check.
  --project-root <path>   Project root used by probe, defaults to this repository.
  --codex-home <path>     Override CODEX_HOME, defaults to ~/.codex.
  --sync-target <path>    Extra plugin cache root to refresh.
  --probe-target <path>   Installed plugin cache root to probe.
  --report-path <path>    Persist JSON report, defaults to scratch/codex-plugin-dev-verify-report.json.
  --no-sync               Do not refresh installed cache before probing.
  --skip-build            Skip npm run build.
  --skip-prepare          Skip prepare:codex-plugin-runtime.
  --skip-tests            Skip focused unit tests.
  --skip-verify           Skip verify:codex-plugin.
  --skip-smoke            Skip smoke:codex-plugin.
  --keep-tmp              Keep temporary verification data.
  -h, --help              Show this help.
`);
}
