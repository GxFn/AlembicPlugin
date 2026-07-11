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
  computeFileHash,
  computeSourceHash,
  validateBuildProvenance,
} from '../../scripts/lib/runtime-pack-freshness.mjs';

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
  roots = [];
});

describe('P3 build provenance', () => {
  test('hashes the exact public entry bytes', () => {
    const dist = makeDist();
    const entry = join(dist, 'lib', 'a.js');
    const before = computeFileHash(entry);
    expect(computeFileHash(entry)).toBe(before);
    writeFileSync(entry, 'export const a = 2;\n');
    expect(computeFileHash(entry)).not.toBe(before);
  });

  test('rejects a build after source HEAD moves even when source bytes are unchanged', () => {
    const manifest = {
      kind: 'AlembicDistBuildManifest',
      version: 2,
      pluginCommit: 'plugin-before-build',
      coreCommit: 'core-build',
      sourceHash: 'source-hash',
      distContentHash: 'dist-hash',
      builtAt: '2026-07-11T00:00:00.000Z',
      publicEntry: 'dist/bin/host-mcp.js',
      publicEntryHash: 'entry-hash',
    };
    const expected = {
      ...manifest,
      pluginCommit: 'plugin-after-build',
    };

    const result = validateBuildProvenance(manifest, expected);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([expect.stringContaining('pluginCommit mismatch')]);
  });

  test('requires commit, source, dist, time and public-entry identities together', () => {
    const result = validateBuildProvenance({ kind: 'AlembicDistBuildManifest', version: 2 }, {});
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('pluginCommit');
    expect(result.failures.join('\n')).toContain('coreCommit');
    expect(result.failures.join('\n')).toContain('publicEntryHash');
  });
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
    // Declarations are skipped by prepare and provenance metadata is excluded
    // from the code-content hash to avoid self-referential hashing.
    writeFileSync(join(dist, 'lib', 'a.d.ts'), 'export declare const a: number;\n');
    writeFileSync(join(dist, '.build-manifest.json'), '{"sourceHash":"deadbeef"}\n');
    writeFileSync(join(dist, '.alembic-runtime-boundary.json'), '{"distContentHash":"x"}\n');
    expect(computeDistContentHash(dist)).toBe(before);
  });
});
