#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveCoreSource } from './local-source-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const tmpRoot = mkdtempSync(join(tmpdir(), 'alembic-codex-runtime-boundary-'));
const packageRoot = join(tmpRoot, 'package-root');
const packDir = join(tmpRoot, 'pack');
const installRoot = join(tmpRoot, 'install');
const npmCache = join(tmpRoot, 'npm-cache');
const sourceManifestPath = join(root, 'packages', 'alembic-codex-runtime', 'package.json');
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
    generatedManifest.bin?.['alembic-codex-mcp'] === 'dist/bin/codex-mcp.js',
    'runtime package must expose bin.alembic-codex-mcp -> dist/bin/codex-mcp.js'
  );
  expect(
    generatedManifest.dependencies?.['@alembic/core'] === '0.2.0',
    'runtime package must pin @alembic/core to exact 0.2.0'
  );
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
  const corePack = run(
    'npm',
    ['pack', coreSource.path, '--json', '--pack-destination', packDir, '--ignore-scripts'],
    {
      cwd: root,
      env: { ...process.env, HUSKY: '0', npm_config_cache: npmCache },
      maxBuffer: 80 * 1024 * 1024,
    }
  );
  const corePackInfo = parseNpmPackJson(corePack.stdout)[0];
  const coreTarball = join(packDir, corePackInfo.filename);
  expect(existsSync(coreTarball), `npm pack did not create ${coreTarball}`);
  expect(corePackInfo.name === '@alembic/core', 'Core pack package name mismatch');
  expect(
    corePackInfo.version === generatedManifest.dependencies?.['@alembic/core'],
    'Core pack version mismatch'
  );
  const tarListing = run('tar', ['-tzf', tarball], { maxBuffer: 80 * 1024 * 1024 })
    .stdout.split('\n')
    .filter(Boolean);
  for (const required of [
    'package/package.json',
    'package/dist/bin/codex-mcp.js',
    'package/dist/lib/codex/mcp/CodexMcpServer.js',
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

  run(
    'npm',
    [
      'install',
      tarball,
      coreTarball,
      '--ignore-scripts',
      '--omit=dev',
      '--package-lock=false',
      '--fetch-retries=0',
      '--fetch-timeout=20000',
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: installRoot,
      env: { ...process.env, HUSKY: '0', npm_config_cache: npmCache },
      maxBuffer: 80 * 1024 * 1024,
      timeout: 120000,
    }
  );
  const installedRoot = join(installRoot, 'node_modules', sourceManifest.name);
  const installedManifest = readJson(join(installedRoot, 'package.json'));
  expect(installedManifest.name === sourceManifest.name, 'installed package name mismatch');
  expect(
    existsSync(join(installedRoot, 'dist', 'bin', 'codex-mcp.js')),
    'installed runtime MCP entrypoint missing'
  );
  expect(
    existsSync(join(installRoot, 'node_modules', '@alembic', 'core', 'package.json')),
    'installed @alembic/core package missing'
  );
  const entrypointProbe = run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const mod = await import(${JSON.stringify(
        join(installedRoot, 'dist', 'lib', 'codex', 'mcp', 'CodexMcpServer.js')
      )}); if (typeof mod.startCodexMcpServer !== 'function') throw new Error('missing startCodexMcpServer');`,
    ],
    { cwd: installRoot, timeout: 15000 }
  );
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
        coreTarball: corePackInfo.filename,
        unpackedSize: packInfo.unpackedSize,
        packFileCount: packInfo.entryCount,
        noFileDependencies: true,
        forbiddenOldShapeRejected: true,
        install: 'passed',
        entrypointProbe: 'passed',
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
