// Side-effect doctrine lint (P2 AD6, Plugin leg): blocks the two machine-
// checkable AD0 doctrine pattern classes over lib/ — method precedent: the
// accepted Core (9d6abf9) and Alembic (c8aaefa) AD6 legs.
//
//  A. module-scope mutable `let` bindings, EXCEPT null-initialized lazy
//     slots (`let _x: T | null = null` — the managed-lifecycle accessor
//     idiom);
//  B. module-scope EMPTY `new Map()` / `new Set()` accumulators (literal-
//     seeded const lookups are immutable and unmatched by construction).
//
// Exemptions come ONLY from config/doctrine-lint-exemptions.json rows,
// each requiring file+binding+owner+reason (this repo has no AD4
// blessed-singletons config; the census-first exemption set is the
// AD-era judgment surface). Row integrity is validated; stale rows that
// no longer match a finding fail the lint so the config cannot rot.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'config/doctrine-lint-exemptions.json'), 'utf8')
);
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);

const LET_BINDING_RE = /^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)[^\n;]*;?\s*$/gm;
const NULL_SLOT_RE = /=\s*null;?\s*$/;
const EMPTY_COLLECTION_RE =
  /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)(\s*:\s*[^=\n]+)?\s*=\s*new\s+(Map|Set)\s*(?:<[^>]*>)?\s*\(\s*\)/gm;

const exemptions = config.exemptions ?? [];
for (const row of exemptions) {
  for (const field of ['file', 'binding', 'owner', 'reason']) {
    if (!row?.[field]) {
      console.error(`Doctrine lint: exemption row ${JSON.stringify(row)} missing '${field}'.`);
      process.exit(1);
    }
  }
}
const exempt = new Set(exemptions.map((row) => `${row.file}::${row.binding}`));
const consumed = new Set();

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(absolute, files);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

function lineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

const violations = [];
let scanned = 0;
for (const absolute of collectFiles(path.join(REPO_ROOT, 'lib'))) {
  const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
  const content = readFileSync(absolute, 'utf8');
  scanned += 1;

  for (const match of content.matchAll(LET_BINDING_RE)) {
    const binding = match[1];
    if (NULL_SLOT_RE.test(match[0].trimEnd())) {
      continue; // null-initialized lazy slot (managed-lifecycle idiom)
    }
    const key = `${relative}::${binding}`;
    if (exempt.has(key)) {
      consumed.add(key);
      continue;
    }
    violations.push(
      `${relative}:${lineAt(content, match.index)} module-scope mutable 'let ${binding}' outside the null-slot idiom — use a managed lifecycle or add an exemption row with owner+reason`
    );
  }

  for (const match of content.matchAll(EMPTY_COLLECTION_RE)) {
    const binding = match[1];
    const key = `${relative}::${binding}`;
    if (exempt.has(key)) {
      consumed.add(key);
      continue;
    }
    violations.push(
      `${relative}:${lineAt(content, match.index)} module-scope empty new ${match[3]}() accumulator '${binding}' — needs a managed lifecycle or an exemption row with owner+reason`
    );
  }
}

for (const key of exempt) {
  if (!consumed.has(key)) {
    violations.push(`stale exemption row ${key} no longer matches any finding — remove it`);
  }
}

if (violations.length > 0) {
  console.error(`Doctrine lint failed: ${violations.length} violation(s) across ${scanned} files.`);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(
  `Doctrine lint OK: ${scanned} lib files clean (null-slot idiom honored; ${exempt.size} exemptions consumed from config/doctrine-lint-exemptions.json).`
);
