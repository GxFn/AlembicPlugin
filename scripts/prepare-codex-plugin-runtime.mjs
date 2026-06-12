#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = readJson(join(root, 'package.json'));
const pluginRoot = join(root, 'plugins', 'alembic-codex');
const startupPath = join(pluginRoot, 'bin', 'alembic-codex-start.mjs');
const runtimePackagePath = join(root, 'packages', 'alembic-codex-runtime', 'package.json');
const runtimePackage = readJson(runtimePackagePath);
const runtimeSpecifier = `${runtimePackage.name}@${runtimePackage.version}`;

for (const forbidden of ['runtime', 'runtime.tgz', 'node_modules']) {
  const forbiddenPath = join(pluginRoot, forbidden);
  if (existsSync(forbiddenPath)) {
    throw new Error(`Public Codex plugin shell must not contain ${forbidden}`);
  }
}
if (!existsSync(startupPath)) {
  throw new Error('Public Codex plugin shell is missing bin/alembic-codex-start.mjs');
}
if (runtimePackage.name !== '@gxfn/alembic-runtime') {
  throw new Error(`Unexpected runtime package name: ${runtimePackage.name}`);
}
if (runtimePackage.version !== packageJson.version) {
  throw new Error(
    `Runtime package version ${runtimePackage.version} must match root package version ${packageJson.version}`
  );
}

const verify = spawnSync(process.execPath, ['scripts/verify-codex-plugin.mjs'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'pipe',
});
if (verify.status !== 0) {
  throw new Error(`Codex plugin shell verification failed\n${verify.stdout}${verify.stderr}`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      mode: 'marketplace-shell',
      pluginRoot,
      startup: 'bin/alembic-codex-start.mjs',
      runtimeSpecifier,
      forbiddenShellArtifactsAbsent: true,
      verification: 'scripts/verify-codex-plugin.mjs',
    },
    null,
    2
  )}\n`
);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
