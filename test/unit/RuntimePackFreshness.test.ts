/**
 * QD1 — TEST-INFRA-STALE-DIST-ALIAS family gate (regression guard).
 *
 * Pins the deterministic hashing the pack/prepare freshness gate relies on:
 *   - computeSourceHash is stable for unchanged inputs and moves when a source
 *     file changes (so a stale dist is detectable vs current source);
 *   - computeDistContentHash is stable, moves on a content change, and excludes
 *     declarations (.d.ts) and build metadata (matching what prepare packs) so
 *     the .tmp freshness pin compares the shipped file set.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  computeDistContentHash,
  computeSourceHash,
} from '../../scripts/lib/runtime-pack-freshness.mjs';

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
  roots = [];
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'qd1-freshness-'));
  roots.push(root);
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{}}\n');
  writeFileSync(join(root, 'lib', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'bin', 'cli.ts'), 'export const cli = true;\n');
  return root;
}

function makeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'qd1-dist-'));
  roots.push(dist);
  mkdirSync(join(dist, 'lib'), { recursive: true });
  writeFileSync(join(dist, 'lib', 'a.js'), 'export const a = 1;\n');
  return dist;
}

describe('QD1 computeSourceHash', () => {
  test('is deterministic for unchanged source', () => {
    const root = makeRepo();
    expect(computeSourceHash(root)).toBe(computeSourceHash(root));
  });

  test('changes when a tracked source file changes (stale-dist detectable)', () => {
    const root = makeRepo();
    const before = computeSourceHash(root);
    writeFileSync(join(root, 'lib', 'a.ts'), 'export const a = 2;\n');
    expect(computeSourceHash(root)).not.toBe(before);
  });

  test('ignores non-source files (only lib/bin .ts(x) + tsconfig count)', () => {
    const root = makeRepo();
    const before = computeSourceHash(root);
    writeFileSync(join(root, 'README.md'), '# unrelated\n');
    writeFileSync(join(root, 'lib', 'notes.md'), 'unrelated\n');
    expect(computeSourceHash(root)).toBe(before);
  });
});

describe('QD1 computeDistContentHash', () => {
  test('is deterministic and moves on a content change', () => {
    const dist = makeDist();
    const before = computeDistContentHash(dist);
    expect(computeDistContentHash(dist)).toBe(before);
    writeFileSync(join(dist, 'lib', 'a.js'), 'export const a = 99;\n');
    expect(computeDistContentHash(dist)).not.toBe(before);
  });

  test('excludes declarations and build metadata from the shipped hash', () => {
    const dist = makeDist();
    const before = computeDistContentHash(dist);
    // Declarations are skipped by prepare (skipDeclarations) and build metadata
    // is local-only — neither may move the shipped-content hash.
    writeFileSync(join(dist, 'lib', 'a.d.ts'), 'export declare const a: number;\n');
    writeFileSync(join(dist, '.build-manifest.json'), '{"sourceHash":"deadbeef"}\n');
    writeFileSync(join(dist, '.alembic-runtime-boundary.json'), '{"distContentHash":"x"}\n');
    expect(computeDistContentHash(dist)).toBe(before);
  });
});
