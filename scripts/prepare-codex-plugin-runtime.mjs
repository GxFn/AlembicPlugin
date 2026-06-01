#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveCoreGrammarSource, resolveCoreSource } from './local-source-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const pluginRoot = join(root, 'plugins', 'alembic-codex');
const runtimeRoot = join(pluginRoot, 'runtime');
const packageJson = readJson(join(root, 'package.json'));

const requiredBuildArtifacts = [
  'dist/bin/codex-mcp.js',
  'dist/bin/daemon-server.js',
  'dist/lib/codex/mcp/CodexMcpServer.js',
];

for (const artifact of requiredBuildArtifacts) {
  assert(existsSync(join(root, artifact)), `${artifact} is missing. Run npm run build first.`);
}

rmSync(runtimeRoot, { force: true, recursive: true });
mkdirSync(runtimeRoot, { recursive: true });

writeRuntimePackageJson();
copyTree('dist', 'dist', { skipDeclarations: true });
copyTree('config', 'config');
copyTree('templates', 'templates');
copyTree('injectable-skills', 'injectable-skills');
copyCoreGrammars();
copyFile('template.json', 'template.json', { optional: true });
copyFile('README.md', 'README.md', { optional: true });
copyFile('README_CN.md', 'README_CN.md', { optional: true });
copyTree('channels', 'channels');
copyTree('.agents', '.agents');
copyEmbeddedCorePackage();
copyBundledRuntimeDependencies();
patchBundledRuntimeDependencies();
copyPluginShellSnapshot();
const runtimeTarballPath = packRuntimeTarball();

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      runtimeRoot,
      runtimeTarballPath,
      package: `${packageJson.name}@${packageJson.version}`,
      entry: 'dist/bin/codex-mcp.js',
      pluginRoot,
    },
    null,
    2
  )}\n`
);

function writeRuntimePackageJson() {
  const runtimePackage = {
    name: packageJson.name,
    version: packageJson.version,
    description: `${packageJson.description} Embedded Codex plugin runtime.`,
    type: packageJson.type,
    main: packageJson.main,
    engines: packageJson.engines,
    imports: normalizeRuntimeImports(packageJson.imports),
    bin: {
      'alembic-codex-mcp': 'dist/bin/codex-mcp.js',
    },
    keywords: packageJson.keywords,
    homepage: packageJson.homepage,
    repository: packageJson.repository,
    bugs: packageJson.bugs,
    license: packageJson.license,
    dependencies: normalizeRuntimeDependencies(packageJson.dependencies),
    overrides: packageJson.overrides,
    bundledDependencies: Object.keys(packageJson.dependencies || {}),
    files: [
      '.agents',
      'channels',
      'config',
      'dist',
      'injectable-skills',
      'plugins/alembic-codex',
      'resources',
      'templates',
      'template.json',
      'vendor/AlembicCore',
      'README.md',
      'README_CN.md',
    ],
  };

  writeFileSync(join(runtimeRoot, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
}

function copyPluginShellSnapshot() {
  const destination = join(runtimeRoot, 'plugins', 'alembic-codex');
  for (const entry of [
    '.agents',
    '.codex-plugin',
    '.mcp.json',
    'README.md',
    'README.zh-CN.md',
    'RELEASE-PLAYBOOK.md',
    'assets',
    'bin',
    'skills',
  ]) {
    const source = join(pluginRoot, entry);
    const target = join(destination, entry);
    if (!existsSync(source)) {
      throw new Error(`Required plugin shell entry is missing: ${entry}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { force: true, recursive: true });
  }
}

function packRuntimeTarball() {
  const runtimeTarballPath = join(pluginRoot, 'runtime.tgz');
  const packRoot = mkdtempSync(join(tmpdir(), 'alembic-codex-runtime-pack-'));
  const npmCache = join(packRoot, 'npm-cache');
  mkdirSync(npmCache, { recursive: true });
  rmSync(runtimeTarballPath, { force: true });

  try {
    const result = spawnSync(
      'npm',
      ['pack', runtimeRoot, '--pack-destination', packRoot, '--ignore-scripts'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          HUSKY: '0',
          npm_config_cache: npmCache,
        },
      }
    );
    if (result.status !== 0) {
      throw new Error(
        `npm pack embedded runtime failed (${result.status})\n${result.stdout}\n${result.stderr}`
      );
    }
    const filename = parseNpmPackFilename(result.stdout);
    if (!filename) {
      throw new Error(`npm pack embedded runtime did not return a filename\n${result.stdout}`);
    }
    const packedPath = join(packRoot, filename);
    if (!existsSync(packedPath)) {
      throw new Error(`npm pack embedded runtime did not create ${packedPath}`);
    }
    renameSync(packedPath, runtimeTarballPath);
    return runtimeTarballPath;
  } finally {
    rmSync(packRoot, { force: true, recursive: true });
  }
}

function copyTree(sourceRelative, destinationRelative, options = {}) {
  const source = join(root, sourceRelative);
  copyTreeFromPath(source, destinationRelative, options, sourceRelative);
}

function copyTreeFromPath(source, destinationRelative, options = {}, label = source) {
  const destination = join(runtimeRoot, destinationRelative);
  if (!existsSync(source)) {
    if (options.optional) {
      return;
    }
    throw new Error(`Required source path is missing: ${label}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    force: true,
    recursive: true,
    filter(sourcePath) {
      return !(options.skipDeclarations && sourcePath.endsWith('.d.ts'));
    },
  });
}

function copyCoreGrammars() {
  const { path: source } = resolveCoreGrammarSource();
  assert(
    existsSync(join(source, 'tree-sitter-typescript.wasm')),
    `Core grammar source is missing tree-sitter-typescript.wasm: ${source}`
  );
  copyTreeFromPath(source, 'resources/grammars', {}, source);
}

function copyEmbeddedCorePackage() {
  const source = resolveEmbeddedCoreSource();
  const destination = join(runtimeRoot, 'vendor', 'AlembicCore');
  for (const entry of ['package.json', 'dist', 'resources', 'config', 'scripts']) {
    const sourcePath = join(source.path, entry);
    if (!existsSync(sourcePath)) {
      throw new Error(`Required embedded Core entry is missing: ${sourcePath}`);
    }
    const targetPath = join(destination, entry);
    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(sourcePath, targetPath, {
      force: true,
      recursive: true,
      filter(sourcePath) {
        return (
          !sourcePath.includes(`${source}/node_modules/`) && !sourcePath.includes(`${source}/.git/`)
        );
      },
    });
  }
  writeEmbeddedCoreSourceMetadata(source);
}

function resolveEmbeddedCoreSource() {
  return resolveCoreSource({ requireDist: true });
}

function writeEmbeddedCoreSourceMetadata(source) {
  writeFileSync(
    join(runtimeRoot, 'vendor', 'AlembicCore', '.alembic-source.json'),
    `${JSON.stringify(
      {
        source: source.label,
        commit: source.commit,
        packageDependency: 'file:vendor/AlembicCore',
      },
      null,
      2
    )}\n`
  );
}

function copyBundledRuntimeDependencies() {
  const source = join(root, 'node_modules');
  const destination = join(runtimeRoot, 'node_modules');
  if (!existsSync(source)) {
    throw new Error('Embedded runtime dependency bundling requires root node_modules.');
  }
  cpSync(source, destination, {
    force: true,
    recursive: true,
    filter(sourcePath) {
      return !sourcePath.includes(`${source}/.cache/`);
    },
  });

  const bundledCore = join(destination, '@alembic', 'core');
  rmSync(bundledCore, { force: true, recursive: true });
  mkdirSync(dirname(bundledCore), { recursive: true });
  cpSync(join(runtimeRoot, 'vendor', 'AlembicCore'), bundledCore, {
    force: true,
    recursive: true,
  });
}

function patchBundledRuntimeDependencies() {
  patchBetterSqlitePackage();
}

function patchBetterSqlitePackage() {
  const packagePath = join(runtimeRoot, 'node_modules', 'better-sqlite3', 'package.json');
  const nativeBinding = join(
    runtimeRoot,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node'
  );
  if (!existsSync(packagePath)) {
    return;
  }
  assert(
    existsSync(nativeBinding),
    'Embedded runtime dependency better-sqlite3 is missing build/Release/better_sqlite3.node'
  );
  const pkg = readJson(packagePath);
  const files = new Set(Array.isArray(pkg.files) ? pkg.files : []);
  files.add('build/**');
  pkg.files = [...files];
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    delete pkg.scripts.install;
  }
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function copyFile(sourceRelative, destinationRelative, options = {}) {
  const source = join(root, sourceRelative);
  const destination = join(runtimeRoot, destinationRelative);
  if (!existsSync(source)) {
    if (options.optional) {
      return;
    }
    throw new Error(`Required source file is missing: ${sourceRelative}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { force: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseNpmPackFilename(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.tgz'))
    .at(-1);
}

function normalizeRuntimeImports(imports) {
  if (!imports || typeof imports !== 'object' || Array.isArray(imports)) {
    return imports;
  }
  const normalized = {};
  for (const [specifier, target] of Object.entries(imports)) {
    if (
      target &&
      typeof target === 'object' &&
      !Array.isArray(target) &&
      typeof target.default === 'string'
    ) {
      normalized[specifier] = target.default;
    } else {
      normalized[specifier] = target;
    }
  }
  return normalized;
}

function normalizeRuntimeDependencies(dependencies) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return dependencies;
  }
  return {
    ...dependencies,
    '@alembic/core': 'file:vendor/AlembicCore',
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
