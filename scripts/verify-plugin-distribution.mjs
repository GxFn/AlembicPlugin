#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJsonPath = join(root, 'package.json');
const runtimePackageJsonPath = join(root, 'packages', 'alembic-runtime', 'package.json');
const marketplacePath = join(root, '.agents', 'plugins', 'marketplace.json');
const errors = [];

const packageJson = readJson(packageJsonPath);
const runtimePackageJson = readJson(runtimePackageJsonPath);
const marketplace = readJson(marketplacePath);
const packageVersion = packageJson.version;
const runtimeSpecifier = `${runtimePackageJson.name}@${runtimePackageJson.version}`;
const marketplaceEntries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
const pluginEntry = marketplaceEntries.find((entry) => entry?.name === 'alembic');

expect(marketplace.name === 'gxfn', 'marketplace name must stay gxfn');
expect(Boolean(pluginEntry), 'marketplace must include the alembic plugin entry');
expect(
  pluginEntry?.source?.source === 'local',
  'alembic plugin distribution must use a local marketplace source'
);
expect(
  pluginEntry?.source?.path === './plugins/alembic-codex',
  'alembic plugin distribution path must be ./plugins/alembic-codex'
);
expect(
  pluginEntry?.policy?.installation === 'AVAILABLE',
  'alembic plugin distribution must be installable'
);
expect(
  pluginEntry?.policy?.authentication === 'ON_INSTALL',
  'alembic plugin authentication policy must stay ON_INSTALL'
);

if (pluginEntry?.source?.path) {
  verifyPlugin({
    packageJson,
    pluginRoot: join(root, pluginEntry.source.path),
    runtimePackageJson,
    runtimeSpecifier,
  });
}

expect(
  runtimePackageJson.name === '@gxfn/alembic-runtime',
  'runtime package must be @gxfn/alembic-runtime'
);
expect(
  runtimePackageJson.version === packageVersion,
  'runtime package version must match the root package version'
);
expect(
  runtimePackageJson.bin?.['alembic-codex-mcp'] === 'dist/bin/codex-mcp.js',
  'runtime package must expose bin.alembic-codex-mcp -> dist/bin/codex-mcp.js'
);
expect(
  runtimePackageJson.dependencies?.['@alembic/core'] === packageVersion,
  `runtime package must pin @alembic/core to ${packageVersion}`
);
expect(
  Array.isArray(runtimePackageJson.files) && !runtimePackageJson.files.includes('channels'),
  'runtime package files[] must not include removed channel metadata'
);

for (const requiredFile of [
  '.agents/plugins/marketplace.json',
  'plugins',
  'packages/alembic-runtime',
  'scripts/verify-plugin-distribution.mjs',
]) {
  expect(
    Array.isArray(packageJson.files) && packageJson.files.includes(requiredFile),
    `package.json files[] must include ${requiredFile}`
  );
}
expect(
  Array.isArray(packageJson.files) && !packageJson.files.includes('channels'),
  'package.json files[] must not include removed channel metadata'
);
expect(
  packageJson.scripts?.['verify:plugin-distribution'] ===
    'node scripts/verify-plugin-distribution.mjs',
  'package.json must expose verify:plugin-distribution'
);
expect(
  !packageJson.scripts?.['verify:codex-channel'],
  'package.json must not expose removed verify:codex-channel'
);

if (errors.length > 0) {
  console.error('Plugin distribution verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

process.stdout.write(`Plugin distribution verification passed (${runtimeSpecifier}).\n`);

function verifyPlugin({ packageJson, pluginRoot, runtimePackageJson, runtimeSpecifier }) {
  const pluginJson = readJson(join(pluginRoot, '.codex-plugin', 'plugin.json'));
  const mcpJson = readJson(join(pluginRoot, '.mcp.json'));
  const server = mcpJson.mcpServers?.alembic;
  const args = Array.isArray(server?.args) ? server.args : [];
  const startupPath = join(pluginRoot, 'bin', 'alembic-start.mjs');
  const startupSource = existsSync(startupPath) ? readFileSync(startupPath, 'utf8') : '';

  expect(existsSync(pluginRoot), `plugin path must exist: ${pluginRoot}`);
  expect(pluginJson.name === 'alembic', 'plugin.json name must be alembic');
  expect(pluginJson.version === packageJson.version, 'plugin version must match root package');
  expect(pluginJson.interface?.displayName === 'Alembic', 'plugin displayName must stay Alembic');
  expect(
    server?.command === 'node' &&
      JSON.stringify(args) === JSON.stringify(['./bin/alembic-start.mjs']),
    'plugin MCP config must launch the relative marketplace shell'
  );
  expect(server?.cwd === '.', 'plugin MCP config must run from the installed plugin root');
  expect(
    server?.env?.ALEMBIC_RUNTIME_MODE === 'plugin',
    'plugin MCP config must set ALEMBIC_RUNTIME_MODE=plugin'
  );
  expect(
    server?.env?.ALEMBIC_PLUGIN_HOST === 'codex',
    'plugin MCP config must set ALEMBIC_PLUGIN_HOST=codex'
  );
  expect(
    !Object.hasOwn(server?.env || {}, 'ALEMBIC_CHANNEL_ID'),
    'plugin MCP config must not set removed ALEMBIC_CHANNEL_ID'
  );
  expect(
    startupSource.includes(runtimeSpecifier),
    `plugin startup shell must use ${runtimeSpecifier}`
  );
  expect(
    !existsSync(join(pluginRoot, 'runtime')),
    'plugin shell must not contain old runtime directory'
  );
  expect(
    !existsSync(join(pluginRoot, 'runtime.tgz')),
    'plugin shell must not contain old runtime tarball'
  );
  expect(
    !existsSync(join(pluginRoot, 'node_modules')),
    'plugin shell must not contain node_modules'
  );
  expect(
    runtimePackageJson.name === '@gxfn/alembic-runtime',
    'plugin distribution must point at the host-neutral runtime package'
  );
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
