#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const allowlistPath = join(root, 'docs', 'core-import-boundary-allowlist.json');
const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules', 'vendor']);
const sourceExtensions = new Set(['.cjs', '.cts', '.js', '.mjs', '.mts', '.ts', '.tsx']);
const staticFromPattern =
  /\b(?:import|export)\s+(?:type\s+)?[^;]*?\bfrom\s*['"](@alembic\/core(?:\/[^'"]+)?)['"]/g;
const sideEffectPattern = /\bimport\s*['"](@alembic\/core(?:\/[^'"]+)?)['"]/g;
const dynamicPattern = /\bimport\s*\(\s*['"](@alembic\/core(?:\/[^'"]+)?)['"]\s*\)/g;

const allowlist = readJson(allowlistPath);
const allowedSpecifiers = allowlist.allowedSpecifiers ?? [];
const scanRoots = allowlist.scanRoots ?? ['lib', 'bin', 'scripts', 'test'];

validateAllowlist(allowedSpecifiers);

const allowed = new Set(['@alembic/core', ...allowedSpecifiers]);
const references = collectReferences(scanRoots);
const unknownReferences = references.filter((reference) => !allowed.has(reference.specifier));
const uniqueSpecifiers = new Set(references.map((reference) => reference.specifier));

if (unknownReferences.length > 0) {
  const grouped = groupBySpecifier(unknownReferences);
  stderr('\nCore import boundary check failed.\n');
  stderr('Unknown @alembic/core import specifiers were found:');
  for (const [specifier, refs] of grouped) {
    stderr(`\n${specifier}`);
    for (const ref of refs) {
      stderr(`  - ${ref.file}:${ref.line}`);
    }
  }
  stderr('\nBefore adding a new Core deep import, record the boundary decision:');
  stderr('  - needed Core capability');
  stderr('  - desired import path');
  stderr('  - deterministic Core API vs Codex adapter/tool/delivery logic');
  stderr('  - whether Core needs a stable facade instead of another deep path');
  process.exit(1);
}

stdout(
  `Core import boundary check passed (${references.length} refs, ${uniqueSpecifiers.size} unique specifiers).`
);

function stdout(message) {
  process.stdout.write(`${message}\n`);
}

function stderr(message) {
  process.stderr.write(`${message}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function validateAllowlist(specifiers) {
  if (!Array.isArray(specifiers)) {
    stderr(`${relative(root, allowlistPath)} must contain allowedSpecifiers[].`);
    process.exit(1);
  }
  const sorted = [...specifiers].sort();
  const duplicates = specifiers.filter(
    (specifier, index) => specifiers.indexOf(specifier) !== index
  );
  const unsorted = specifiers.some((specifier, index) => specifier !== sorted[index]);

  if (duplicates.length > 0 || unsorted) {
    stderr(`${relative(root, allowlistPath)} must keep allowedSpecifiers sorted and unique.`);
    if (duplicates.length > 0) {
      stderr(`Duplicate entries: ${[...new Set(duplicates)].join(', ')}`);
    }
    process.exit(1);
  }
}

function collectReferences(rootNames) {
  const files = rootNames.flatMap((rootName) => {
    const absoluteRoot = join(root, rootName);
    if (!existsSync(absoluteRoot)) {
      return [];
    }
    return collectSourceFiles(absoluteRoot);
  });

  return files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [
      ...findMatches(source, file, staticFromPattern),
      ...findMatches(source, file, sideEffectPattern),
      ...findMatches(source, file, dynamicPattern),
    ];
  });
}

function collectSourceFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        return [];
      }
      return collectSourceFiles(path);
    }
    if (!entry.isFile() || !sourceExtensions.has(extname(entry.name))) {
      return [];
    }
    return [path];
  });
}

function findMatches(source, file, pattern) {
  const matches = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(source);
  while (match !== null) {
    const specifier = match[1];
    const specifierOffset = match.index + match[0].indexOf(specifier);
    matches.push({
      file: relative(root, file),
      line: lineForOffset(source, specifierOffset),
      specifier,
    });
    match = pattern.exec(source);
  }
  return matches;
}

function lineForOffset(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function groupBySpecifier(references) {
  const grouped = new Map();
  for (const reference of references) {
    const refs = grouped.get(reference.specifier) ?? [];
    refs.push(reference);
    grouped.set(reference.specifier, refs);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
}
