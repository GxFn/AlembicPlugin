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
import { dirname, join, resolve } from 'node:path';
import { resolveCoreSource } from './local-source-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const verificationTmpRoot = join(root, '.tmp');
mkdirSync(verificationTmpRoot, { recursive: true });
const tmpRoot = mkdtempSync(join(verificationTmpRoot, 'alembic-runtime-boundary-'));
const packageRoot = join(tmpRoot, 'package-root');
const packDir = join(tmpRoot, 'pack');
const installRoot = mkdtempSync(join(tmpdir(), 'alembic-runtime-install-'));
const npmCache = join(tmpRoot, 'npm-cache');
const sourceManifestPath = join(root, 'packages', 'alembic-runtime', 'package.json');
const sourceManifest = readJson(sourceManifestPath);
const coreSource = resolveCoreSource({ requireDist: true });
const coreManifest = readJson(join(coreSource.path, 'package.json'));
const errors = [];

mkdirSync(packDir, { recursive: true });
mkdirSync(installRoot, { recursive: true });
mkdirSync(npmCache, { recursive: true });

try {
  const prepare = run(
    process.execPath,
    [join(root, 'scripts', 'prepare-codex-runtime-package.mjs'), '--output', packageRoot],
    { cwd: root }
  );
  const prepared = JSON.parse(prepare.stdout);
  const generatedManifestPath = join(packageRoot, 'package.json');
  const generatedManifest = readJson(generatedManifestPath);

  expect(prepared.packageName === sourceManifest.name, 'prepared package name mismatch');
  expect(generatedManifest.name === sourceManifest.name, 'runtime package name mismatch');
  expect(generatedManifest.private !== true, 'runtime package must be publishable, not private');
  expect(
    generatedManifest.bin?.['alembic-codex-mcp'] === 'dist/bin/host-mcp.js',
    'runtime package must expose bin.alembic-codex-mcp -> dist/bin/host-mcp.js'
  );
  expect(
    generatedManifest.dependencies?.['@alembic/core'] === coreManifest.version,
    `runtime package must pin @alembic/core to exact ${coreManifest.version}`
  );
  for (const [name, version] of Object.entries(coreManifest.dependencies || {})) {
    expect(
      generatedManifest.dependencies?.[name] === version,
      `runtime package must carry Core-owned dependency ${name}@${version}`
    );
  }
  expectNoFileDependencies(generatedManifest, 'generated runtime package');
  expectNoFileDependencies(sourceManifest, 'source runtime manifest');
  expectNoFileDependencies(coreManifest, 'Core package manifest');
  expectNoForbiddenGeneratedShape(packageRoot);

  const pack = run(
    'npm',
    ['pack', packageRoot, '--json', '--pack-destination', packDir, '--ignore-scripts'],
    {
      cwd: root,
      env: { ...process.env, HUSKY: '0', npm_config_cache: npmCache },
      maxBuffer: 80 * 1024 * 1024,
    }
  );
  const packInfo = parseNpmPackJson(pack.stdout)[0];
  const tarball = join(packDir, packInfo.filename);
  expect(existsSync(tarball), `npm pack did not create ${tarball}`);
  const tarListing = run('tar', ['-tzf', tarball], { maxBuffer: 80 * 1024 * 1024 })
    .stdout.split('\n')
    .filter(Boolean);
  for (const required of [
    'package/package.json',
    'package/dist/bin/host-mcp.js',
    'package/dist/lib/host-runtime/mcp/HostMcpServer.js',
    'package/resources/grammars/tree-sitter-typescript.wasm',
    'package/.alembic-runtime-boundary.json',
  ]) {
    expect(tarListing.includes(required), `runtime tarball missing ${required}`);
  }
  for (const forbidden of [
    'package/runtime.tgz',
    'package/runtime/package.json',
    'package/plugins/alembic-codex/runtime.tgz',
    'package/plugins/alembic-codex/runtime/package.json',
  ]) {
    expect(!tarListing.includes(forbidden), `runtime tarball contains forbidden ${forbidden}`);
  }
  expect(
    !tarListing.some((entry) => entry.startsWith('package/plugins/alembic-codex/runtime/')),
    'runtime tarball must not embed the old public plugin runtime/ directory'
  );

  const installArgs = [
    'install',
    tarball,
    '--ignore-scripts',
    '--omit=dev',
    '--package-lock=false',
    '--fetch-retries=0',
    '--fetch-timeout=20000',
    '--no-audit',
    '--no-fund',
  ];
  const installResult = spawnSync('npm', installArgs, {
    cwd: installRoot,
    encoding: 'utf8',
    env: { ...process.env, HUSKY: '0', npm_config_cache: npmCache },
    maxBuffer: 80 * 1024 * 1024,
    timeout: 300000,
  });
  let installMode = 'npm-install';
  if (installResult.status !== 0) {
    const installError = `${installResult.stdout || ''}${installResult.stderr || ''}`;
    if (!/ENOTFOUND|EAI_AGAIN|network request to/u.test(installError)) {
      throw new Error(`npm ${installArgs.join(' ')} failed\n${installError}`);
    }
    installOfflineFromTarball(tarball, generatedManifest);
    installMode = 'offline-tarball-load-with-workspace-dependencies';
  }
  const installedRoot = join(installRoot, 'node_modules', sourceManifest.name);
  const installedManifest = readJson(join(installedRoot, 'package.json'));
  expect(installedManifest.name === sourceManifest.name, 'installed package name mismatch');
  expect(
    existsSync(join(installedRoot, 'dist', 'bin', 'host-mcp.js')),
    'installed runtime MCP entrypoint missing'
  );
  // 只安装用户实际取得的 runtime tarball；另装 Core tarball 会替它补依赖、掩盖缺包。
  const installedCoreManifest = readJson(
    join(installedRoot, 'node_modules', '@alembic', 'core', 'package.json')
  );
  expect(installedCoreManifest.version === coreManifest.version, 'bundled Core version mismatch');

  // 在安装包内部解析 import-only Core 公开入口，并启动真实 SDK worker。
  // 普通变量符号及真实调用观察同时验证依赖闭包、包内资源和生产接线。
  const sdkProbePath = join(installedRoot, '.sdk-boundary-probe.mjs');
  writeFileSync(
    sdkProbePath,
    `import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withCodeGraphProjectContextSession } from '@alembic/core/project-context';
import { startHostMcpServer } from './dist/lib/host-runtime/mcp/HostMcpServer.js';
assert.equal(typeof startHostMcpServer, 'function');
const projectRoot = join(${JSON.stringify(installRoot)}, 'sdk-project');
await mkdir(projectRoot);
await writeFile(join(projectRoot, 'index.ts'), [
  'export const installedSdkSymbol = 1;',
  'function target() {}',
  'export function run(client) { target(); target(); client.target(); }',
].join('\\n'));
let runtimeRoot;
await withCodeGraphProjectContextSession({ dataRoot: join(projectRoot, 'private') }, async (context, runtime) => {
  runtimeRoot = runtime.runtimeRoot;
  const result = await context.execute({ kind: 'file-symbols', scope: { projectRoot }, payload: { filePath: 'index.ts' } });
  assert.deepEqual(result.errors ?? [], []);
  assert(result.data.symbols.some((symbol) => symbol.name === 'installedSdkSymbol'));
  const flow = await context.execute({ kind: 'file-flow', scope: { projectRoot }, payload: { filePath: 'index.ts' } });
  assert.deepEqual(flow.errors ?? [], []);
  const calls = flow.data.callers;
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((call) => call.ref.id)).size, 3);
  assert.equal(calls.filter((call) => call.to?.ref && !call.unresolved).length, 2);
  assert.equal(calls.filter((call) => call.unresolved && !call.to?.ref).length, 1);
});
assert.deepEqual(await readdir(runtimeRoot), []);
console.log('installed SDK symbols, call observations, and worker cleanup passed');
`
  );
  const entrypointProbe = run(process.execPath, [sdkProbePath], {
    cwd: installRoot,
    timeout: 45000,
  });
  expect(entrypointProbe.status === 0, 'runtime MCP entrypoint module probe failed');

  if (errors.length > 0) {
    fail();
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        packageName: sourceManifest.name,
        packageVersion: installedManifest.version,
        tarball: packInfo.filename,
        bundledCoreVersion: installedCoreManifest.version,
        unpackedSize: packInfo.unpackedSize,
        packFileCount: packInfo.entryCount,
        noFileDependencies: true,
        forbiddenOldShapeRejected: true,
        install: installMode,
        entrypointProbe: 'passed',
        codeGraphExtraction: 'passed',
        codeGraphFileFlow: 'passed',
        coreDependency: installedManifest.dependencies?.['@alembic/core'],
      },
      null,
      2
    )}\n`
  );
} finally {
  if (process.env.KEEP_RUNTIME_BOUNDARY_TMP === '1') {
    console.error(`Runtime package boundary temp kept at ${tmpRoot}`);
  } else {
    rmSync(tmpRoot, { force: true, recursive: true });
    rmSync(installRoot, { force: true, recursive: true });
  }
}

function installOfflineFromTarball(tarball, manifest) {
  const extractRoot = join(tmpRoot, 'offline-extract');
  mkdirSync(extractRoot, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', extractRoot], { maxBuffer: 80 * 1024 * 1024 });
  const installedRoot = join(installRoot, 'node_modules', sourceManifest.name);
  mkdirSync(join(installRoot, 'node_modules'), { recursive: true });
  cpSync(join(extractRoot, 'package'), installedRoot, { force: true, recursive: true });
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    if (dependency === '@alembic/core') {
      continue;
    }
    // Core 新增的依赖可能只在本地 Core 安装；离线模式仍按同一依赖所有者解析。
    const ownerRoot = Object.hasOwn(coreManifest.dependencies || {}, dependency)
      ? coreSource.path
      : root;
    const source = join(ownerRoot, 'node_modules', dependency);
    const destination = join(installRoot, 'node_modules', dependency);
    if (!existsSync(source)) {
      throw new Error(
        `Offline runtime verification is missing workspace dependency ${dependency}.`
      );
    }
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(source, destination, 'junction');
  }
}

function expectNoFileDependencies(manifest, label) {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const entries = manifest[field] && typeof manifest[field] === 'object' ? manifest[field] : {};
    for (const [name, value] of Object.entries(entries)) {
      expect(
        typeof value !== 'string' || !value.startsWith('file:'),
        `${label} must not use local file dependency ${field}.${name}: ${value}`
      );
    }
  }
}

function expectNoForbiddenGeneratedShape(rootPath) {
  for (const forbidden of ['runtime.tgz', join('runtime', 'package.json')]) {
    expect(
      !existsSync(join(rootPath, forbidden)),
      `generated runtime package contains ${forbidden}`
    );
  }
  expect(
    !existsSync(join(rootPath, 'plugins', 'alembic-codex', 'runtime')),
    'generated runtime package must not contain old plugin shell runtime/'
  );
  expect(
    !existsSync(join(rootPath, 'plugins', 'alembic-codex', 'runtime.tgz')),
    'generated runtime package must not contain old plugin shell runtime.tgz'
  );
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

function parseNpmPackJson(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) {
    throw new Error(`npm pack did not emit JSON output:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function expect(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function fail() {
  console.error('Codex runtime package boundary verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}
