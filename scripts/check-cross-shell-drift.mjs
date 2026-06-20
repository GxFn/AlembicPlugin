// Cross-shell drift gate (DH-4c per-host reshape; supersedes the P3 byte-identical
// model). The Codex shell (plugins/alembic-codex) and the Claude Code shell
// (plugins/alembic-claude-code) share host-AGNOSTIC functional artifacts, while the
// dual-host product model (DH-4) lets them diverge on host-SPECIFIC surfaces:
//
//   - LICENSE                 → fully shared, byte-identical.
//   - bin/ bootstrap          → shared logic with a per-host host-identity default
//                               (`ALEMBIC_PLUGIN_HOST || '<host>'`); byte-identical
//                               after normalizing that one default so the cc shell may
//                               default to claude-code while the rest of bin stays in sync.
//   - skills/ tool guidance   → the manifest `skill-shared-sections` skills
//                               (alembic-create/guard/recipes/structure) carry
//                               host-divergent tool surfaces (codex alembic_knowledge /
//                               alembic_guard ↔ cc alembic_search / alembic_code_guard);
//                               each side is its own per-host authority, so they are
//                               per-host (presence required, content not cross-shell
//                               byte-compared). Host-AGNOSTIC skills stay byte-identical.
//
// NOTE: the shell skill files are full copies without wakeflow-shared markers, so
// cross-shell coherence is enforced at file granularity (the host-divergent skill set,
// derived from config/shared-asset-manifest.json to stay in sync). The marked-section
// coherence of the source skills against the Alembic per-host authority is the separate
// responsibility of check-shared-asset-drift.mjs. Manifests (.codex-plugin/, .claude-plugin/,
// .mcp.json, marketplace, READMEs, metadata) remain per-host by design and exempt.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_SHELL = path.join(repoRoot, 'plugins', 'alembic-codex');
const CLAUDE_SHELL = path.join(repoRoot, 'plugins', 'alembic-claude-code');
const SHARED_PATHS = ['bin', 'skills', 'LICENSE'];

// Skills whose bodies are host-divergent (per-host product surfaces). Derived from the
// shared-asset manifest's `skill-shared-sections` assets so this gate and the
// source→Alembic gate stay in sync. These are presence-checked cross-shell but their
// content is per-host (each shell is its own authority; coherence vs main is the
// shared-asset gate's job).
function loadHostDivergentSkillFiles() {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'config', 'shared-asset-manifest.json'), 'utf8')
    );
    return new Set(
      (manifest.assets || [])
        .filter((asset) => asset.mode === 'skill-shared-sections' && typeof asset.path === 'string')
        .map((asset) => asset.path)
    );
  } catch {
    return new Set();
  }
}
const HOST_DIVERGENT_SKILL_FILES = loadHostDivergentSkillFiles();

// Normalize the per-host host-identity bootstrap default so a cc default of 'claude-code'
// does not read as drift against the codex default of 'codex'. Only this declared
// per-host token is canonicalized; every other byte of bin/ must still match.
function normalizeBin(buffer) {
  return buffer
    .toString('utf8')
    .replace(
      /(ALEMBIC_PLUGIN_HOST:\s*input\.env\.ALEMBIC_PLUGIN_HOST\s*\|\|\s*)(['"])(?:codex|claude-code)\2/g,
      '$1$2<host>$2'
    );
}

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
let perHostSkipped = 0;
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
  // File-presence parity is always required (a missing/extra file is drift even for
  // per-host content).
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
    // Host-divergent skill bodies are per-host: presence checked above, content skipped.
    if (HOST_DIVERGENT_SKILL_FILES.has(file)) {
      perHostSkipped += 1;
      continue;
    }
    let a = readFileSync(path.join(CODEX_SHELL, file));
    let b = readFileSync(path.join(CLAUDE_SHELL, file));
    // bin/: canonicalize the per-host host-identity default before comparing.
    if (file.startsWith(`bin${path.sep}`) || file.startsWith('bin/')) {
      a = Buffer.from(normalizeBin(a));
      b = Buffer.from(normalizeBin(b));
    }
    if (!a.equals(b)) {
      report(`${file} differs between the shells (host-agnostic content must stay byte-identical)`);
    }
  }
}

if (issues > 0) {
  console.error(
    `[cross-shell-drift] FAIL — ${issues} drift issue(s). Host-agnostic shared artifacts (LICENSE, bin bootstrap logic, host-agnostic skills) must stay byte-identical between plugins/alembic-codex and plugins/alembic-claude-code; mirror the originating change to the sibling shell (see PLUGIN-SOURCE.json sync rule). Host-divergent skill bodies are governed per-host by check-shared-asset-drift.mjs.`
  );
  process.exit(1);
}

console.log(
  `[cross-shell-drift] PASS — host-agnostic shared artifacts byte-identical between the two shells (${perHostSkipped} per-host skill body/-ies governed by the shared-asset per-host model; bin host-identity default normalized).`
);
