#!/usr/bin/env node

/**
 * clean-scratch.mjs — scratch/ retention cleanup (RC4 P3)
 *
 * scratch/ is gitignored local probe/acceptance output. Completed-demand
 * `afapi-*` packs accumulate multi-GB runtime caches and are reclaimable once
 * the owning demand is accepted and archived in the workspace ledger.
 *
 * Scope and safety:
 *   - Only top-level `scratch/afapi-*` entries are candidates. Other entries
 *     (active-sequence probes, ad-hoc reports) are never touched.
 *   - Entries named in LEDGER_REFERENCED_WHITELIST are always kept; they are
 *     cited by ledger acceptance records and must survive cleanup.
 *   - Entry age = newest file mtime inside the entry (recursive), so a pack
 *     still being written to is never considered stale.
 *   - Dry-run by default; pass --apply to delete. A supervised run records
 *     the before/after size delta in its report output.
 *
 * Usage:
 *   node scripts/clean-scratch.mjs                      # dry-run, 7-day retention
 *   node scripts/clean-scratch.mjs --retention-days 0   # dry-run, everything non-whitelisted
 *   node scripts/clean-scratch.mjs --apply              # delete per current retention
 *   node scripts/clean-scratch.mjs --json --report-path scratch-clean-report.json
 */

import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratchDir = join(repoRoot, 'scratch');

// Ledger-referenced acceptance packs (wakeflow-ledger AFAPI completion records).
// Adding an entry here requires a ledger citation; removing one requires the
// citing ledger record to be archived or rewritten first.
const LEDGER_REFERENCED_WHITELIST = new Set([
  'afapi-req-08-p5-controller-readback.json',
  'afapi-req-10-controller-review-public-tools-readback.json',
]);

const TARGET_PREFIX = 'afapi-';
const DEFAULT_RETENTION_DAYS = 7;

const options = parseArgs(process.argv.slice(2));
const retentionMs = options.retentionDays * 24 * 60 * 60 * 1000;
const now = Date.now();

let entries;
try {
  entries = readdirSync(scratchDir, { withFileTypes: true });
} catch {
  process.stdout.write('scratch/ does not exist; nothing to clean\n');
  process.exit(0);
}

const report = {
  mode: options.apply ? 'apply' : 'dry-run',
  retentionDays: options.retentionDays,
  generatedAt: new Date().toISOString(),
  totalBeforeBytes: 0,
  totalAfterBytes: 0,
  freedBytes: 0,
  kept: [],
  whitelisted: [],
  outOfScope: [],
  deleted: [],
};

for (const entry of entries) {
  const entryPath = join(scratchDir, entry.name);
  const sizeBytes = entrySize(entryPath);
  report.totalBeforeBytes += sizeBytes;

  if (!entry.name.startsWith(TARGET_PREFIX)) {
    report.outOfScope.push({ name: entry.name, sizeBytes });
    report.totalAfterBytes += sizeBytes;
    continue;
  }
  if (LEDGER_REFERENCED_WHITELIST.has(entry.name)) {
    report.whitelisted.push({ name: entry.name, sizeBytes });
    report.totalAfterBytes += sizeBytes;
    continue;
  }

  const newestMtime = newestFileMtime(entryPath);
  const ageDays = (now - newestMtime) / (24 * 60 * 60 * 1000);
  if (now - newestMtime < retentionMs) {
    report.kept.push({ name: entry.name, sizeBytes, ageDays: round1(ageDays) });
    report.totalAfterBytes += sizeBytes;
    continue;
  }

  report.deleted.push({ name: entry.name, sizeBytes, ageDays: round1(ageDays) });
  report.freedBytes += sizeBytes;
  if (options.apply) {
    rmSync(entryPath, { recursive: true, force: true });
  }
}

if (options.reportPath) {
  writeFileSync(resolve(options.reportPath), `${JSON.stringify(report, null, 2)}\n`);
}
if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const verb = options.apply ? 'deleted' : 'would delete';
  for (const item of report.deleted) {
    process.stdout.write(
      `${verb} ${item.name} (${formatBytes(item.sizeBytes)}, age ${item.ageDays}d)\n`
    );
  }
  process.stdout.write(
    `${report.mode} retention=${options.retentionDays}d ` +
      `${verb}=${report.deleted.length} kept=${report.kept.length} ` +
      `whitelisted=${report.whitelisted.length} out-of-scope=${report.outOfScope.length} ` +
      `before=${formatBytes(report.totalBeforeBytes)} ` +
      `after=${formatBytes(options.apply ? report.totalAfterBytes : report.totalBeforeBytes)} ` +
      `freed=${formatBytes(report.freedBytes)}${options.apply ? '' : ' (dry-run, nothing removed)'}\n`
  );
}

function entrySize(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    return stats.size;
  }
  let total = 0;
  for (const child of readdirSync(path, { withFileTypes: true })) {
    total += entrySize(join(path, child.name));
  }
  return total;
}

function newestFileMtime(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }
  let newest = 0;
  for (const child of readdirSync(path, { withFileTypes: true })) {
    newest = Math.max(newest, newestFileMtime(join(path, child.name)));
  }
  // Empty directory: fall back to its own mtime.
  return newest || stats.mtimeMs;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${bytes}B`;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function parseArgs(args) {
  const out = {
    apply: false,
    json: false,
    reportPath: null,
    retentionDays: DEFAULT_RETENTION_DAYS,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') {
      out.apply = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--report-path') {
      out.reportPath = args[++i] ?? null;
    } else if (arg === '--retention-days') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('--retention-days requires a non-negative number');
      }
      out.retentionDays = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}
