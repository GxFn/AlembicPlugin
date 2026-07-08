#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { computeDistContentHash, computeSourceHash } from './lib/runtime-pack-freshness.mjs';
import { resolveCoreGrammarSource, resolveCoreSource } from './local-source-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const sourceManifestPath = join(root, 'packages', 'alembic-runtime', 'package.json');
const outputRoot = resolveArg('--output') || join(root, '.tmp', 'alembic-runtime-package');
const rootPackage = readJson(join(root, 'package.json'));
const sourceManifest = readJson(sourceManifestPath);
const coreSource = resolveCoreSource({ requireDist: true });
const corePackage = readJson(join(coreSource.path, 'package.json'));

const requiredBuildArtifacts = [
  'dist/bin/host-mcp.js',
  'dist/lib/host-runtime/mcp/HostMcpServer.js',
];

for (const artifact of requiredBuildArtifacts) {
  assert(existsSync(join(root, artifact)), `${artifact} is missing. Run npm run build first.`);
}

// QD1 clean-build-before-pack gate: refuse to stage a runtime package from a
// dist that is stale vs current source (TEST-INFRA-STALE-DIST-ALIAS). The
// source hash recorded by postbuild must match the live source.
const buildManifest = readJsonOptional(join(root, 'dist', '.build-manifest.json'));
assert(
  buildManifest?.sourceHash,
  'dist/.build-manifest.json is missing or has no sourceHash. Run npm run build before preparing the runtime package.'
);
assert(
  buildManifest.sourceHash === computeSourceHash(root),
  'dist is stale vs source (lib/bin/tsconfig changed since the last build). Run npm run build before preparing the runtime package.'
);
assert(
  sourceManifest.dependencies?.['@alembic/core'] === corePackage.version,
  `Runtime manifest must pin @alembic/core to ${corePackage.version}.`
);

rmSync(outputRoot, { force: true, recursive: true });
mkdirSync(outputRoot, { recursive: true });

writeRuntimePackageJson();
copyTree('dist', 'dist', { skipDeclarations: true });
copyTree('config', 'config');
copyTree('templates', 'templates');
copyTree('skills', 'skills');
copyTree('.agents', '.agents');
copyFile('template.json', 'template.json', { optional: true });
copyFile('README.md', 'README.md', { optional: true });
copyFile('README_CN.md', 'README_CN.md', { optional: true });
copyFile('packages/alembic-runtime/README.md', 'README.md');
copyCoreGrammars();
bundleCoreDependency();
writeRuntimeBoundaryMetadata();

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      packageRoot: outputRoot,
      packageName: sourceManifest.name,
      packageVersion: rootPackage.version,
      corePackage: `${corePackage.name}@${corePackage.version}`,
      entrypoint: 'dist/bin/host-mcp.js',
      sourceManifest: sourceManifestPath,
    },
    null,
    2
  )}\n`
);

function writeRuntimePackageJson() {
  const runtimePackage = {
    ...sourceManifest,
    version: rootPackage.version,
    imports: sourceManifest.imports || rootPackage.imports,
    dependencies: normalizeRuntimeDependencies(sourceManifest.dependencies || {}),
    // Path B（自足 npm runtime）：@alembic/core 私有、不在公共 registry，故 vendored 进
    // node_modules/@alembic/core，随本包 tarball 一起发布（bundledDependencies）。安装时
    // npm 直接用 bundle 的副本，不去 registry 拉 @alembic/core；其余依赖（better-sqlite3
    // /web-tree-sitter 等）都是公共 npm 包，按平台正常解析（含原生预编译）。
    bundledDependencies: ['@alembic/core'],
  };
  delete runtimePackage.private;
  writeFileSync(join(outputRoot, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
}

function normalizeRuntimeDependencies(dependencies) {
  const normalized = {};
  for (const [name, version] of Object.entries(dependencies)) {
    normalized[name] = name === '@alembic/core' ? corePackage.version : version;
  }
  return normalized;
}

function copyTree(sourceRelative, destinationRelative, options = {}) {
  const source = join(root, sourceRelative);
  const destination = join(outputRoot, destinationRelative);
  if (!existsSync(source)) {
    if (options.optional) {
      return;
    }
    throw new Error(`Required source path is missing: ${sourceRelative}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    force: true,
    recursive: true,
    filter(sourcePath) {
      if (options.skipDeclarations && sourcePath.endsWith('.d.ts')) {
        return false;
      }
      // QD1: the build manifest is local freshness metadata, not shipped code.
      return !sourcePath.endsWith('/.build-manifest.json');
    },
  });
}

function copyFile(sourceRelative, destinationRelative, options = {}) {
  const source = join(root, sourceRelative);
  const destination = join(outputRoot, destinationRelative);
  if (!existsSync(source)) {
    if (options.optional) {
      return;
    }
    throw new Error(`Required source file is missing: ${sourceRelative}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { force: true });
}

function bundleCoreDependency() {
  // Path B：把私有 @alembic/core vendored 进 node_modules/@alembic/core，使其随
  // runtime tarball 一起发布（bundledDependencies）。用 `npm pack` 取 Core 的“已发布形态”
  // （尊重 Core package.json 的 `files` 白名单），再解压到位。Core 自身的依赖不 bundle——
  // 它们已声明在本 runtime 包的 dependencies 里，安装时从顶层 node_modules 解析。
  const destination = join(outputRoot, 'node_modules', '@alembic', 'core');
  const packDir = join(outputRoot, '.core-pack');
  mkdirSync(packDir, { recursive: true });
  const packed = spawnSync(
    'npm',
    ['pack', coreSource.path, '--pack-destination', packDir, '--silent'],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }
  );
  assert(
    !packed.error && packed.status === 0,
    `Failed to npm pack @alembic/core from ${coreSource.path}: ${packed.error?.message || packed.stderr}`
  );
  const tarball = packed.stdout.trim().split('\n').pop().trim();
  const tarballPath = join(packDir, tarball);
  assert(existsSync(tarballPath), `npm pack did not produce a Core tarball at ${tarballPath}`);
  const extractDir = join(packDir, 'extract');
  mkdirSync(extractDir, { recursive: true });
  // npm tarballs 顶层是 `package/`。
  const extracted = spawnSync('tar', ['-xzf', tarballPath, '-C', extractDir], {
    encoding: 'utf8',
  });
  assert(
    !extracted.error && extracted.status === 0,
    `Failed to extract Core tarball ${tarballPath}: ${extracted.error?.message || extracted.stderr}`
  );
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { force: true, recursive: true });
  cpSync(join(extractDir, 'package'), destination, { force: true, recursive: true });
  rmSync(packDir, { force: true, recursive: true });
  assert(
    existsSync(join(destination, 'package.json')) && existsSync(join(destination, 'dist')),
    'Bundled @alembic/core is missing package.json or dist after vendoring.'
  );
  const bundledCore = readJson(join(destination, 'package.json'));
  assert(
    bundledCore.version === corePackage.version,
    `Bundled @alembic/core version ${bundledCore.version} does not match ${corePackage.version}.`
  );
}

function copyCoreGrammars() {
  const { path: source } = resolveCoreGrammarSource();
  assert(
    existsSync(join(source, 'tree-sitter-typescript.wasm')),
    `Core grammar source is missing tree-sitter-typescript.wasm: ${source}`
  );
  const destination = join(outputRoot, 'resources', 'grammars');
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { force: true, recursive: true });
}

function writeRuntimeBoundaryMetadata() {
  writeFileSync(
    join(outputRoot, '.alembic-runtime-boundary.json'),
    `${JSON.stringify(
      {
        kind: 'AlembicCodexRuntimePackageBoundary',
        version: 1,
        packageName: sourceManifest.name,
        packageVersion: rootPackage.version,
        // QD1 .tmp freshness pin: the repo dist hash this package was prepared
        // from. check-runtime-pack-freshness fails if repo dist later diverges.
        distContentHash: computeDistContentHash(join(root, 'dist')),
        corePackage: `${corePackage.name}@${corePackage.version}`,
        coreSource: coreSource.label,
        coreCommit: coreSource.commit,
        dependencyStrategy:
          'Path B self-contained runtime: private @alembic/core is vendored into node_modules/@alembic/core and shipped via bundledDependencies, so the runtime installs from npm without @alembic/core being published to any registry. All other dependencies are public npm packages resolved normally at install (native prebuilds per-platform). The lightweight marketplace shell stays runtime-free; forbiddenShellArtifacts applies to the shell, not this runtime package.',
        bundledDependencies: ['@alembic/core'],
        forbiddenShellArtifacts: ['runtime.tgz', 'runtime/', 'node_modules/'],
      },
      null,
      2
    )}\n`
  );
}

function resolveArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? resolve(value) : null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonOptional(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
