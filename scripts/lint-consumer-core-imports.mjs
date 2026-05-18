#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, resolveCoreSource } from './local-source-paths.mjs';

const core = resolveCoreSource();
const scanner = join(core.path, 'scripts', 'lint-consumer-core-imports.mjs');
if (!existsSync(scanner)) {
  throw new Error(`Core import boundary scanner is missing from ${core.label}: ${scanner}`);
}

const args = [scanner, '.', '--config', 'config/core-import-boundary-allowlist.json'];
args.push(...process.argv.slice(2));

const result = spawnSync(process.execPath, args, {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    HUSKY: '0',
  },
  stdio: 'inherit',
});

if (result.status !== 0) {
  throw new Error(
    `Core import boundary scanner from ${core.label} failed with exit code ${result.status}`
  );
}
