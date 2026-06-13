#!/usr/bin/env node
/**
 * QD1 — TEST-INFRA-STALE-DIST-ALIAS family gate.
 *
 * Two checks that close the recurring stale-dist failure mode (ta10 #alias-dist,
 * N1 staged stale dist, P5 t5 .tmp at f5bdab6 — the Plugin pack-path instances):
 *
 *   A. clean-build-before-pack: dist/ must be freshly built from current source.
 *      Compares the source hash recorded in dist/.build-manifest.json (written by
 *      postbuild) against the live source hash. Fails if source changed without a
 *      rebuild, so a stale dist can never be packed/cert-seeded silently.
 *
 *   B. .tmp freshness pin: a prepared runtime package
 *      (.tmp/alembic-runtime-package) must match the current repo dist.
 *      Compares the distContentHash pinned into its
 *      .alembic-runtime-boundary.json against the live repo dist hash. Fails if
 *      repo dist moved since the package was prepared (i.e. .tmp dist != repo dist).
 *
 * Build/pack tooling only — no served/runtime behavior. Exit 0 = fresh; non-zero
 * with a clear message = stale.
 *
 *   node scripts/check-runtime-pack-freshness.mjs [--require-prepared] [--prepared <dir>]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { computeDistContentHash, computeSourceHash } from './lib/runtime-pack-freshness.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const distDir = join(repoRoot, 'dist');
const requirePrepared = process.argv.includes('--require-prepared');
const preparedDir = resolveArg('--prepared') || join(repoRoot, '.tmp', 'alembic-runtime-package');

const failures = [];
const notes = [];

// ── Check A: dist fresh vs source ──────────────────────────────────────────
const manifestPath = join(distDir, '.build-manifest.json');
if (!existsSync(manifestPath)) {
  failures.push(
    `dist/.build-manifest.json is missing — dist is unbuilt or built by an older toolchain. Run \`npm run build\` before packing.`
  );
} else {
  const recorded = readJson(manifestPath)?.sourceHash;
  const live = computeSourceHash(repoRoot);
  if (recorded !== live) {
    failures.push(
      `dist is STALE vs source: build-manifest sourceHash ${short(recorded)} != current source ${short(live)}. lib/bin/tsconfig changed since the last build — run \`npm run build\` before packing.`
    );
  } else {
    notes.push(`clean-build gate: dist matches current source (${short(live)}).`);
  }
}

// ── Check B: prepared .tmp package matches repo dist ────────────────────────
const boundaryPath = join(preparedDir, '.alembic-runtime-boundary.json');
if (!existsSync(preparedDir) || !existsSync(boundaryPath)) {
  const msg = `no prepared runtime package at ${rel(preparedDir)} (freshness pin not applicable).`;
  if (requirePrepared) {
    failures.push(`${msg} Run \`npm run prepare:codex-runtime-package\` first.`);
  } else {
    notes.push(msg);
  }
} else {
  const pinned = readJson(boundaryPath)?.distContentHash;
  const liveDist = computeDistContentHash(distDir);
  if (!pinned) {
    failures.push(
      `prepared package boundary is missing distContentHash — it was staged by an older prepare. Re-run \`npm run prepare:codex-runtime-package\`.`
    );
  } else if (pinned !== liveDist) {
    failures.push(
      `prepared .tmp package is STALE vs repo dist: pinned distContentHash ${short(pinned)} != live repo dist ${short(liveDist)}. Repo dist moved since prepare — re-run \`npm run prepare:codex-runtime-package\`.`
    );
  } else {
    notes.push(`.tmp freshness pin: prepared package matches repo dist (${short(liveDist)}).`);
  }
}

for (const note of notes) {
  process.stdout.write(`runtime-pack-freshness: ok — ${note}\n`);
}
if (failures.length > 0) {
  process.stderr.write('runtime-pack-freshness: FAILED\n');
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}
process.stdout.write('runtime-pack-freshness: PASS\n');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
function short(value) {
  return typeof value === 'string' ? value.slice(0, 12) : String(value);
}
function rel(path) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
}
function resolveArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? resolve(value) : null;
}
