#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dashboardRoot = join(root, 'vendor', 'AlembicDashboard');
const sourceDist = join(dashboardRoot, 'dist');
const targetDist = join(root, 'dashboard', 'dist');

assertExists(join(dashboardRoot, 'package.json'), 'vendor/AlembicDashboard/package.json');
assertExists(join(dashboardRoot, 'src'), 'vendor/AlembicDashboard/src');

if (!existsSync(join(dashboardRoot, 'node_modules'))) {
  throw new Error(
    'Dashboard dependencies are missing. Run npm ci --prefix vendor/AlembicDashboard first.'
  );
}

run('npm', ['--prefix', 'vendor/AlembicDashboard', 'run', 'build']);

rmSync(targetDist, { force: true, recursive: true });
mkdirSync(join(root, 'dashboard'), { recursive: true });
cpSync(sourceDist, targetDist, { force: true, recursive: true });
assertExists(join(targetDist, 'index.html'), 'dashboard/dist/index.html');

process.stdout.write('Dashboard build copied from vendor/AlembicDashboard to dashboard/dist.\n');

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
