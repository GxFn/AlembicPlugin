#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { computeDistContentHash, computeSourceHash } from './lib/runtime-pack-freshness.mjs';
import { resolveCoreGrammarSource, resolveCoreSource } from './local-source-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const sourceManifestPath = join(root, 'packages', 'alembic-codex-runtime', 'package.json');
const outputRoot = resolveArg('--output') || join(root, '.tmp', 'alembic-codex-runtime-package');
const rootPackage = readJson(join(root, 'package.json'));
const sourceManifest = readJson(sourceManifestPath);
const coreSource = resolveCoreSource({ requireDist: true });
const corePackage = readJson(join(coreSource.path, 'package.json'));

const requiredBuildArtifacts = [
  'dist/bin/codex-mcp.js',
  'dist/bin/daemon-server.js',
  'dist/lib/runtime/mcp/CodexMcpServer.js',
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
copyTree('injectable-skills', 'injectable-skills');
copyTree('channels', 'channels');
copyTree('.agents', '.agents');
copyFile('template.json', 'template.json', { optional: true });
copyFile('README.md', 'README.md', { optional: true });
copyFile('README_CN.md', 'README_CN.md', { optional: true });
copyFile('packages/alembic-codex-runtime/README.md', 'README.md');
copyCoreGrammars();
writeRuntimeBoundaryMetadata();

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      packageRoot: outputRoot,
      packageName: sourceManifest.name,
      packageVersion: rootPackage.version,
      corePackage: `${corePackage.name}@${corePackage.version}`,
      entrypoint: 'dist/bin/codex-mcp.js',
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
          'Runtime package manifest pins @alembic/core to an exact npm package version. MPB1 verifies pack/install with a matching Core tarball that simulates the published Core package; no production file: dependency escapes the runtime package boundary.',
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
