#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = readJson(join(root, 'package.json'));
const rootReadmePath = join(root, 'README.md');
const rootReadmeCnPath = join(root, 'README_CN.md');
const pluginRoot = join(root, 'plugins', 'alembic-codex');
const pluginJsonPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
const mcpJsonPath = join(pluginRoot, '.mcp.json');
const rootConfigPath = join(root, 'config', 'default.json');
const marketplacePath = join(root, '.agents', 'plugins', 'marketplace.json');
const distributionMarketplacePath = join(pluginRoot, '.agents', 'plugins', 'marketplace.json');
const readmePath = join(pluginRoot, 'README.md');
const readmeCnPath = join(pluginRoot, 'README.zh-CN.md');
const releasePlaybookPath = join(pluginRoot, 'RELEASE-PLAYBOOK.md');
const runtimePackagePath = join(root, 'packages', 'alembic-codex-runtime', 'package.json');
const startupPath = join(pluginRoot, 'bin', 'alembic-start.mjs');
const errors = [];

const pluginJson = readJson(pluginJsonPath);
const mcpJson = readJson(mcpJsonPath);
const rootConfigJson = readJson(rootConfigPath);
const marketplaceJson = readJson(marketplacePath);
const distributionMarketplaceJson = readJson(distributionMarketplacePath);
const runtimePackageJson = readJson(runtimePackagePath);
const startupSource = existsSync(startupPath) ? readFileSync(startupPath, 'utf8') : '';
const packageVersion = packageJson.version;
const runtimePackageName = '@gxfn/alembic-runtime';
const expectedRuntime = `${runtimePackageName}@${packageVersion}`;
const server = mcpJson.mcpServers?.alembic;
const args = Array.isArray(server?.args) ? server.args : [];
const iface = pluginJson.interface || {};
const marketplaceEntry = Array.isArray(marketplaceJson.plugins)
  ? marketplaceJson.plugins.find((entry) => entry?.name === 'alembic')
  : null;
const distributionMarketplaceEntry = Array.isArray(distributionMarketplaceJson.plugins)
  ? distributionMarketplaceJson.plugins.find((entry) => entry?.name === 'alembic')
  : null;

expect(
  packageJson.name === 'alembic-codex-plugin-runtime',
  'root package identity must stay the private AlembicPlugin development package'
);
expect(packageJson.private === true, 'root package.json must stay private');
expect(
  packageJson.bin?.['alembic-codex-mcp'] === 'dist/bin/codex-mcp.js',
  'package.json must expose bin.alembic-codex-mcp -> dist/bin/codex-mcp.js'
);
expect(
  !Object.hasOwn(rootConfigJson, 'ai'),
  'root config/default.json must not ship an AlembicPlugin-owned AI provider default'
);
for (const requiredFile of [
  '.agents/plugins/marketplace.json',
  'plugins',
  'packages/alembic-codex-runtime',
  'scripts/prepare-codex-runtime-package.mjs',
  'scripts/verify-codex-runtime-package-boundary.mjs',
  'scripts/verify-codex-plugin.mjs',
  'scripts/probe-codex-plugin-startup-runtime.mjs',
  'scripts/smoke-codex-plugin.mjs',
  'scripts/prepare-codex-plugin-runtime.mjs',
  'scripts/release-codex-plugin.mjs',
]) {
  expect(
    Array.isArray(packageJson.files) && packageJson.files.includes(requiredFile),
    `package.json files[] must include ${requiredFile}`
  );
}
for (const [scriptName, scriptValue] of [
  ['prepare:codex-runtime-package', 'node scripts/prepare-codex-runtime-package.mjs'],
  ['verify:codex-runtime-package', 'node scripts/verify-codex-runtime-package-boundary.mjs'],
  ['prepare:codex-plugin-runtime', 'node scripts/prepare-codex-plugin-runtime.mjs'],
  ['verify:codex-plugin', 'node scripts/verify-codex-plugin.mjs'],
  ['smoke:codex-plugin', 'node scripts/smoke-codex-plugin.mjs'],
  ['release:codex-plugin', 'node scripts/release-codex-plugin.mjs'],
  ['release:codex-plugin:daemon', 'node scripts/release-codex-plugin.mjs --daemon'],
]) {
  expect(
    packageJson.scripts?.[scriptName] === scriptValue,
    `package.json must expose ${scriptName}`
  );
}

expect(
  runtimePackageJson.name === runtimePackageName,
  `runtime package must be ${runtimePackageName}`
);
expect(
  runtimePackageJson.version === packageVersion,
  `runtime package version must be ${packageVersion}`
);
expect(
  runtimePackageJson.bin?.['alembic-codex-mcp'] === 'dist/bin/codex-mcp.js',
  'runtime package must expose bin.alembic-codex-mcp -> dist/bin/codex-mcp.js'
);
expect(
  runtimePackageJson.dependencies?.['@alembic/core'] === packageVersion,
  `runtime package must pin @alembic/core to ${packageVersion}`
);
for (const forbiddenRuntimeFile of [
  'runtime.tgz',
  'runtime/package.json',
  'plugins/alembic-codex/runtime.tgz',
]) {
  expect(
    !(
      Array.isArray(runtimePackageJson.files) &&
      runtimePackageJson.files.includes(forbiddenRuntimeFile)
    ),
    `runtime package files[] must not publish old shell artifact ${forbiddenRuntimeFile}`
  );
}

expect(
  pluginJson.name === 'alembic',
  'plugin.json name must be alembic (naming ruling C2, 2026-06-13)'
);
expect(pluginJson.interface?.displayName === 'Alembic', 'plugin displayName must be Alembic');
expect(
  pluginJson.interface?.shortDescription?.includes('Local project memory'),
  'plugin shortDescription must describe local project memory'
);
for (const keyword of ['codex', 'codex-plugin', 'local-first', 'dashboard', 'bootstrap']) {
  expect(
    Array.isArray(pluginJson.keywords) && pluginJson.keywords.includes(keyword),
    `plugin keywords must include ${keyword}`
  );
}

expect(server?.command === 'node', '.mcp.json must launch Node');
expect(
  JSON.stringify(args) === JSON.stringify(['./bin/alembic-start.mjs']),
  '.mcp.json must call the relative marketplace shell ./bin/alembic-start.mjs'
);
expect(server?.cwd === '.', '.mcp.json must run from the installed plugin root');
expect(!args.includes('latest'), '.mcp.json must not use latest');
expect(!args.some((arg) => arg.startsWith('/')), '.mcp.json args must stay relative');
for (const [envName, envValue] of [
  ['ALEMBIC_CHANNEL_ID', 'codex'],
  ['ALEMBIC_RUNTIME_MODE', 'plugin'],
  ['ALEMBIC_PLUGIN_HOST', 'codex'],
  ['ALEMBIC_MCP_MODE', '1'],
  ['ALEMBIC_CODEX_MCP_MODE', '1'],
  ['ALEMBIC_CODEX_PLUGIN_ROOT', '.'],
  ['ALEMBIC_MCP_TIER', 'agent'],
  ['ALEMBIC_CODEX_ENABLE_ADMIN', '0'],
]) {
  expect(server?.env?.[envName] === envValue, `.mcp.json must set ${envName}=${envValue}`);
}
expect(!server?.env?.npm_config_cache, '.mcp.json must not force an npm cache path');

expect(existsSync(startupPath), 'marketplace shell startup script must exist');
expect(startupSource.includes(expectedRuntime), `startup script must target ${expectedRuntime}`);
expect(startupSource.includes("'npm'"), 'startup script must install through npm by default');
expect(startupSource.includes("'install'"), 'startup script must run npm install when needed');
expect(
  startupSource.includes('ALEMBIC_CODEX_RUNTIME_CACHE_DIR'),
  'startup script must support deterministic runtime cache selection'
);
expect(
  startupSource.includes('ALEMBIC_CODEX_RUNTIME_OFFLINE'),
  'startup script must support offline cached startup'
);
expect(
  startupSource.includes('ALEMBIC_CODEX_RUNTIME_LOCK_TIMEOUT'),
  'startup script must classify startup lock timeout'
);
expect(
  startupSource.includes('ALEMBIC_CODEX_RUNTIME_VERSION_MISMATCH_AFTER_INSTALL'),
  'startup script must classify post-install version mismatch'
);
expect(
  startupSource.includes('ALEMBIC_CODEX_RUNTIME_ENTRYPOINT_MISSING'),
  'startup script must classify missing runtime entrypoint'
);
expect(startupSource.includes('alembic-codex-mcp'), 'startup script must invoke alembic-codex-mcp');
expect(!startupSource.includes('latest'), 'startup script must not use latest');
expect(
  !startupSource.includes('alembic-codex-mcp-wrapper'),
  'startup script must not call the legacy wrapper'
);
expect(
  !startupSource.includes('runtime.tgz'),
  'startup script must not refer to the old runtime tarball'
);
expect(
  !startupSource.includes("resolve(pluginRoot, 'node_modules')"),
  'startup script must not depend on a public plugin-root node_modules directory'
);
verifyStartupDryRun();
verifyForbiddenShellArtifacts();

expect(
  distributionMarketplaceJson.name === 'gxfn',
  'plugin distribution marketplace must be named gxfn'
);
expect(
  Boolean(distributionMarketplaceEntry),
  'plugin distribution marketplace must include alembic'
);
if (distributionMarketplaceEntry) {
  expect(
    distributionMarketplaceEntry.source?.source === 'local',
    'plugin distribution source must be local'
  );
  expect(distributionMarketplaceEntry.source?.path === '.', 'plugin distribution path must be .');
  expect(
    distributionMarketplaceEntry.policy?.installation === 'AVAILABLE',
    'plugin distribution installation must be AVAILABLE'
  );
  expect(
    distributionMarketplaceEntry.policy?.authentication === 'ON_INSTALL',
    'plugin distribution authentication must be ON_INSTALL'
  );
}
expect(marketplaceJson.name === 'gxfn', 'root marketplace must be named gxfn');
expect(Boolean(marketplaceEntry), 'root marketplace must include alembic');
if (marketplaceEntry) {
  expect(marketplaceEntry.source?.source === 'local', 'root marketplace source must be local');
  expect(
    marketplaceEntry.source?.path === './plugins/alembic-codex',
    'root marketplace path must be ./plugins/alembic-codex'
  );
  expect(
    marketplaceEntry.policy?.installation === 'AVAILABLE',
    'root marketplace installation must be AVAILABLE'
  );
  expect(
    marketplaceEntry.policy?.authentication === 'ON_INSTALL',
    'root marketplace authentication must be ON_INSTALL'
  );
  expect(
    marketplaceEntry.category === iface.category,
    'root marketplace category must match plugin interface category'
  );
}

const assets = [
  iface.composerIcon,
  iface.logo,
  ...(Array.isArray(iface.screenshots) ? iface.screenshots : []),
].filter(Boolean);
expect(assets.length >= 3, 'plugin interface should declare composerIcon, logo, and screenshots');
for (const asset of assets) {
  expect(existsSync(join(pluginRoot, asset)), `missing plugin asset: ${asset}`);
}
for (const skill of [
  'alembic',
  'alembic-create',
  'alembic-guard',
  'alembic-recipes',
  'alembic-structure',
]) {
  expect(existsSync(join(pluginRoot, 'skills', skill, 'SKILL.md')), `missing skill: ${skill}`);
}

const readme = readText(readmePath);
const readmeCn = readText(readmeCnPath);
const rootReadme = readText(rootReadmePath);
const rootReadmeCn = readText(rootReadmeCnPath);
expect(existsSync(readmeCnPath), 'plugin Chinese README must exist');
expect(readme.includes(expectedRuntime), `README.md must mention ${expectedRuntime}`);
expect(readmeCn.includes(expectedRuntime), `README.zh-CN.md must mention ${expectedRuntime}`);
expect(readme.includes('alembic-start.mjs'), 'README.md must mention the marketplace shell entry');
expect(
  readmeCn.includes('alembic-start.mjs'),
  'README.zh-CN.md must mention the marketplace shell entry'
);
expect(
  readme.includes('Chinese version: [README.zh-CN.md](README.zh-CN.md)'),
  'plugin README must link to Chinese README'
);
expect(
  readmeCn.includes('English version: [README.md](README.md)'),
  'plugin Chinese README must link to English README'
);
expect(
  readme.includes('codex plugin marketplace add GxFn/AlembicCodex --ref main'),
  'plugin README must document install command'
);
expect(
  readmeCn.includes('codex plugin marketplace add GxFn/AlembicCodex --ref main'),
  'plugin Chinese README must document install command'
);
expect(
  readme.includes('alembic_codex_diagnostics'),
  'README.md must document alembic_codex_diagnostics'
);
expect(
  readmeCn.includes('alembic_codex_diagnostics'),
  'README.zh-CN.md must document alembic_codex_diagnostics'
);
expect(readme.includes('alembic_codex_cleanup'), 'README.md must document cleanup policy');
expect(readmeCn.includes('alembic_codex_cleanup'), 'README.zh-CN.md must document cleanup policy');
expect(existsSync(releasePlaybookPath), 'plugin release playbook must exist');
const releasePlaybook = readText(releasePlaybookPath);
for (const phrase of [
  'Version And Tag Flow',
  'Test Matrix',
  'Manual Codex App Pass',
  'Promotion Plan',
]) {
  expect(releasePlaybook.includes(phrase), `release playbook must include ${phrase}`);
}
expect(
  releasePlaybook.includes(expectedRuntime),
  `release playbook must mention ${expectedRuntime}`
);
expect(rootReadme.includes('## Codex 插件'), 'root README must document Codex plugin');
expect(rootReadmeCn.includes('## Codex 插件'), 'Chinese README must document Codex plugin');

if (errors.length > 0) {
  console.error('Codex plugin verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

process.stdout.write(`Codex plugin verification passed (${expectedRuntime} via ${args[0]}).\n`);

function verifyStartupDryRun() {
  const result = spawnSync(process.execPath, [startupPath, '--dry-run'], {
    cwd: pluginRoot,
    encoding: 'utf8',
  });
  expect(result.status === 0, `startup dry-run must pass: ${result.stderr || result.stdout}`);
  if (result.status !== 0) {
    return;
  }
  const dryRun = safeParseJson(result.stdout, 'startup dry-run JSON');
  expect(dryRun.ok === true, 'startup dry-run must report ok=true');
  expect(dryRun.cwd === pluginRoot, 'startup dry-run cwd must resolve to plugin root');
  expect(dryRun.command === process.execPath, 'startup dry-run command must launch Node runtime');
  expect(
    String(dryRun.args?.[0] || '').endsWith('dist/bin/codex-mcp.js'),
    'startup dry-run args must point at the cached runtime MCP entrypoint'
  );
  expect(
    dryRun.runtimePackage?.specifier === expectedRuntime,
    'startup dry-run runtime specifier mismatch'
  );
  expect(dryRun.npm?.command === 'npm', 'startup dry-run npm command must default to npm');
  expect(
    Array.isArray(dryRun.npm?.args) && dryRun.npm.args.includes(expectedRuntime),
    'startup dry-run npm args must install the exact pinned runtime package'
  );
  expect(
    dryRun.runtimeCache?.lockDir?.endsWith('.install.lock'),
    'startup dry-run must expose the runtime install lock path'
  );
  expect(
    dryRun.env?.ALEMBIC_CODEX_PLUGIN_ROOT === pluginRoot,
    'startup dry-run must pass absolute plugin root to runtime'
  );
  expect(
    dryRun.env?.ALEMBIC_CODEX_RUNTIME_PACKAGE_SPECIFIER === expectedRuntime,
    'startup dry-run must pass pinned runtime specifier to runtime env'
  );
}

function verifyForbiddenShellArtifacts() {
  const forbiddenPaths = [
    'runtime',
    'runtime.tgz',
    'node_modules',
    join('bin', 'alembic-codex-mcp-wrapper.mjs'),
  ];
  for (const forbiddenPath of forbiddenPaths) {
    expect(
      !existsSync(join(pluginRoot, forbiddenPath)),
      `public plugin shell must not contain ${forbiddenPath}`
    );
  }

  for (const file of collectFiles(pluginRoot)) {
    const rel = relative(pluginRoot, file);
    const parts = rel.split(/[\\/]+/);
    expect(
      !parts.includes('runtime'),
      `public plugin shell must not contain runtime path segment: ${rel}`
    );
    expect(
      !parts.includes('node_modules'),
      `public plugin shell must not contain node_modules path segment: ${rel}`
    );
    expect(
      !rel.endsWith('runtime.tgz'),
      `public plugin shell must not contain runtime.tgz: ${rel}`
    );
  }
}

function collectFiles(path) {
  const stats = statSync(path);
  if (stats.isFile()) {
    return [path];
  }
  if (!stats.isDirectory()) {
    return [];
  }
  return readdirSync(path).flatMap((entry) => collectFiles(join(path, entry)));
}

function expect(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`Unable to read JSON ${path}: ${error.message}`);
    return {};
  }
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function safeParseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push(`Unable to parse ${label}: ${error.message}`);
    return {};
  }
}
