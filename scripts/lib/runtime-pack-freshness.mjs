// QD1 — TEST-INFRA-STALE-DIST-ALIAS family closure.
//
// Deterministic content hashes that let the pack/prepare path prove the
// runtime package is built from current source and that a staged .tmp package
// is not stale vs the repo dist. Tooling only — never imported by runtime/
// served code; see scripts/check-runtime-pack-freshness.mjs for the gate.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Metadata files that live under dist/ but are NOT compiled output; excluded
// from the dist content hash so the hash reflects only built code.
export const DIST_METADATA_BASENAMES = new Set([
  '.build-manifest.json',
  '.alembic-runtime-boundary.json',
]);

function walkFiles(rootDir, options = {}) {
  const { skip = () => false } = options;
  const out = [];
  function recurse(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(full);
      } else if (entry.isFile() && !skip(full)) {
        out.push(full);
      }
    }
  }
  recurse(rootDir);
  return out;
}

function hashFileList(baseDir, files) {
  const hash = createHash('sha256');
  for (const file of files.slice().sort()) {
    const rel = relative(baseDir, file).split(sep).join('/');
    const content = readFileSync(file);
    hash.update(rel, 'utf8');
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Hash of the build INPUTS (lib + bin TypeScript sources + tsconfig). The dist
 * is "fresh" iff this matches the value recorded in dist/.build-manifest.json
 * at build time. package.json is intentionally excluded so unrelated metadata
 * edits (scripts, keywords) do not falsely flag dist as stale.
 */
export function computeSourceHash(repoRoot) {
  const files = [];
  for (const dir of ['lib', 'bin']) {
    files.push(
      ...walkFiles(join(repoRoot, dir), {
        skip: (full) => !/\.(ts|tsx)$/.test(full),
      })
    );
  }
  const tsconfig = join(repoRoot, 'tsconfig.json');
  if (statSafe(tsconfig)) {
    files.push(tsconfig);
  }
  return hashFileList(repoRoot, files);
}

/**
 * Hash of the dist content that actually ships in the runtime package — same
 * file set prepare-codex-runtime-package copies (declarations skipped),
 * excluding non-code metadata. Used as the .tmp freshness pin.
 */
export function computeDistContentHash(distDir) {
  const files = walkFiles(distDir, {
    skip: (full) =>
      full.endsWith('.d.ts') || DIST_METADATA_BASENAMES.has(full.split(sep).pop() ?? ''),
  });
  return hashFileList(distDir, files);
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
