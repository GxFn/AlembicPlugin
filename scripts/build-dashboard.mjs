#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDashboardSource } from './local-source-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dashboardSource = resolveDashboardSource();
const dashboardRoot = dashboardSource.path;
const sourceDist = join(dashboardRoot, 'dist');
const targetDist = join(root, 'dashboard', 'dist');

assertExists(join(dashboardRoot, 'package.json'), `${dashboardSource.label}/package.json`);
assertExists(join(dashboardRoot, 'src'), `${dashboardSource.label}/src`);

if (!existsSync(join(dashboardRoot, 'node_modules'))) {
  throw new Error(
    `Dashboard dependencies are missing. Run npm ci --prefix ${dashboardSource.label} first.`
  );
}

run('npm', ['--prefix', dashboardRoot, 'run', 'build']);

rmSync(targetDist, { force: true, recursive: true });
mkdirSync(join(root, 'dashboard'), { recursive: true });
cpSync(sourceDist, targetDist, { force: true, recursive: true });
assertExists(join(targetDist, 'index.html'), 'dashboard/dist/index.html');

process.stdout.write(
  `Dashboard build copied from ${dashboardSource.label}${
    dashboardSource.commit ? ` @ ${dashboardSource.commit}` : ''
  } to dashboard/dist.\n`
);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HUSKY: '0',
    },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function assertExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`Required Dashboard path is missing: ${label}`);
  }
}
