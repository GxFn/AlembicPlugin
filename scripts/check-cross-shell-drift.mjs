// Cross-shell drift gate (P3 step 5; automates the t5 PLUGIN-SOURCE.json
// sync rule): the Codex shell (plugins/alembic-codex) and the Claude Code
// shell (plugins/alembic-claude-code) intentionally share their functional
// artifacts byte-for-byte — bin/ bootstrap, skills/, LICENSE. Host manifests
// (.codex-plugin/, .claude-plugin/, .mcp.json, marketplace files, READMEs,
// package metadata) are per-host by design and exempt. A divergence in the
// shared set is a sync defect: fix it in the shell where the change
// originated and mirror it to the sibling, naming both shells in the commit.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_SHELL = path.join(repoRoot, 'plugins', 'alembic-codex');
const CLAUDE_SHELL = path.join(repoRoot, 'plugins', 'alembic-claude-code');
const SHARED_PATHS = ['bin', 'skills', 'LICENSE'];

function listFiles(root, rel = '') {
  const abs = path.join(root, rel);
  const stats = statSync(abs);
  if (stats.isFile()) {
    return [rel];
  }
  const files = [];
  for (const entry of readdirSync(abs).sort()) {
    if (entry === '.DS_Store') {
      continue;
    }
    files.push(...listFiles(root, path.join(rel, entry)));
  }
  return files;
}

let issues = 0;
const report = (line) => {
  issues += 1;
  console.error(`[cross-shell-drift] DRIFT: ${line}`);
};

for (const shared of SHARED_PATHS) {
  let left;
  let right;
  try {
    left = listFiles(CODEX_SHELL, shared);
  } catch {
    report(`${shared} missing in plugins/alembic-codex`);
    continue;
  }
  try {
    right = listFiles(CLAUDE_SHELL, shared);
  } catch {
    report(`${shared} missing in plugins/alembic-claude-code`);
    continue;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  for (const file of left) {
    if (!rightSet.has(file)) {
      report(`${file} exists only in plugins/alembic-codex`);
    }
  }
  for (const file of right) {
    if (!leftSet.has(file)) {
      report(`${file} exists only in plugins/alembic-claude-code`);
    }
  }
  for (const file of left) {
    if (!rightSet.has(file)) {
      continue;
    }
    const a = readFileSync(path.join(CODEX_SHELL, file));
    const b = readFileSync(path.join(CLAUDE_SHELL, file));
    if (!a.equals(b)) {
      report(`${file} differs between the shells`);
    }
  }
}

if (issues > 0) {
  console.error(
    `[cross-shell-drift] FAIL — ${issues} drift issue(s). Shared artifacts (${SHARED_PATHS.join(
      ', '
    )}) must stay byte-identical between plugins/alembic-codex and plugins/alembic-claude-code; mirror the originating change to the sibling shell (see PLUGIN-SOURCE.json sync rule).`
  );
  process.exit(1);
}

console.log(
  `[cross-shell-drift] PASS — shared artifacts (${SHARED_PATHS.join(', ')}) byte-identical between the two shells.`
);
