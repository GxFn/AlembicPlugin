#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot, resolveCoreSource } from './local-source-paths.mjs';

const core = resolveCoreSource();
const result = spawnSync('tsc', ['-p', join(core.path, 'tsconfig.json')], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    HUSKY: '0',
  },
  stdio: 'inherit',
});

if (result.status !== 0) {
  throw new Error(`Core build from ${core.label} failed with exit code ${result.status}`);
}

process.stdout.write(`Core build used ${core.label}${core.commit ? ` @ ${core.commit}` : ''}.\n`);
