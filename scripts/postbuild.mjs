#!/usr/bin/env node
/**
 * postbuild script: Add shebang lines to compiled bin/ files
 * and set executable permissions.
 *
 * This runs as a plain .mjs file (not compiled by tsc) because it's
 * part of the build pipeline itself.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeDistContentHash,
  computeFileHash,
  computeSourceHash,
} from './lib/runtime-pack-freshness.mjs';
import { resolveCoreSource } from './local-source-paths.mjs';

const __dirname = import.meta.dirname;
const repoRoot = join(__dirname, '..');
const distBin = join(repoRoot, 'dist', 'bin');

const shebang = '#!/usr/bin/env node\n';

const binFiles = ['host-mcp.js'];

for (const file of binFiles) {
  const filePath = join(distBin, file);
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.startsWith('#!')) {
      writeFileSync(filePath, shebang + content);
    }
    chmodSync(filePath, 0o755);
  } catch (err) {
    console.warn(`⚠ ${file}: ${err.message}`);
  }
}

const publicEntry = 'dist/bin/host-mcp.js';
const coreSource = resolveCoreSource({ requireDist: true });
const pluginCommit = gitHead(repoRoot);
const coreCommit = coreSource.commit || gitHead(coreSource.path);

// The manifest is part of the shipped provenance chain. distContentHash excludes
// metadata files, so writing the manifest does not change the recorded code hash.
writeFileSync(
  join(repoRoot, 'dist', '.build-manifest.json'),
  `${JSON.stringify(
    {
      kind: 'AlembicDistBuildManifest',
      version: 2,
      repository: 'AlembicPlugin',
      pluginCommit,
      coreCommit,
      sourceHash: computeSourceHash(repoRoot),
      distContentHash: computeDistContentHash(join(repoRoot, 'dist')),
      builtAt: new Date().toISOString(),
      publicEntry,
      publicEntryHash: computeFileHash(join(repoRoot, publicEntry)),
    },
    null,
    2
  )}\n`
);

function gitHead(cwd) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}
