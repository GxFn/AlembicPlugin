#!/usr/bin/env node
/**
 * postbuild script: Add shebang lines to compiled bin/ files
 * and set executable permissions.
 *
 * This runs as a plain .mjs file (not compiled by tsc) because it's
 * part of the build pipeline itself.
 */

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeSourceHash } from './lib/runtime-pack-freshness.mjs';

const __dirname = import.meta.dirname;
const repoRoot = join(__dirname, '..');
const distBin = join(repoRoot, 'dist', 'bin');

const shebang = '#!/usr/bin/env node\n';

const binFiles = ['daemon-server.js', 'codex-mcp.js'];

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

// QD1 stale-dist gate: record the source hash this dist was built from so the
// pack/prepare freshness gate can fail loudly if dist is later packed while
// stale vs source. Written under dist/ (wiped by clean-dist each build) and
// excluded from the packed runtime artifact.
writeFileSync(
  join(repoRoot, 'dist', '.build-manifest.json'),
  `${JSON.stringify(
    { kind: 'AlembicDistBuildManifest', version: 1, sourceHash: computeSourceHash(repoRoot) },
    null,
    2
  )}\n`
);
