#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--root requires a path');
      }
      options.root = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

const GATED_DIRECTORIES = ['lib/recipe-generation/host-agent-workflows/'];

const GATED_FILES = new Set(['lib/runtime/KnowledgeState.ts']);

const FROM_PROJECT_CALL = /\b(?:WorkspaceResolver|WR)\s*\.\s*fromProject\s*\(/;
const VALID_SINGLE_ROOT = /\/\/\s*@scope-singleroot\((?:permanent|temporary)\)\s+[—-]\s+\S/;
const ANY_SINGLE_ROOT = /@scope-singleroot/;

const writeStdout = (message) => process.stdout.write(`${message}\n`);
const writeStderr = (message) => process.stderr.write(`${message}\n`);

function isGatedFile(repoRelativePath) {
  if (GATED_FILES.has(repoRelativePath)) {
    return true;
  }
  return GATED_DIRECTORIES.some((dir) => repoRelativePath.startsWith(dir));
}

function walkTypescriptFiles(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(rootDir)) {
    const absolutePath = path.join(rootDir, entry);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      files.push(...walkTypescriptFiles(absolutePath));
    } else if (entry.endsWith('.ts')) {
      files.push(absolutePath);
    }
  }
  return files;
}

function hasValidSingleRootAnnotation(line, previousLine) {
  return VALID_SINGLE_ROOT.test(line) || VALID_SINGLE_ROOT.test(previousLine ?? '');
}

function checkFile(repoRoot, absolutePath) {
  const repoRelativePath = toPosix(path.relative(repoRoot, absolutePath));
  if (!isGatedFile(repoRelativePath)) {
    return [];
  }

  const lines = readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  const violations = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const previousLine = lines[index - 1] ?? '';

    if (ANY_SINGLE_ROOT.test(line) && !VALID_SINGLE_ROOT.test(line)) {
      violations.push({
        line: index + 1,
        message:
          'invalid @scope-singleroot annotation; use // @scope-singleroot(permanent|temporary) - reason',
        repoRelativePath,
        snippet: line.trim(),
      });
      continue;
    }

    if (!FROM_PROJECT_CALL.test(line)) {
      continue;
    }
    if (line.includes('fromProjectScopeRegistry')) {
      continue;
    }
    if (hasValidSingleRootAnnotation(line, previousLine)) {
      continue;
    }

    violations.push({
      line: index + 1,
      message: 'Plugin scan/write paths must use WorkspaceResolver.fromProjectScopeRegistry',
      repoRelativePath,
      snippet: line.trim(),
    });
  }

  return violations;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    writeStdout(`Usage: node scripts/lint-scope-resolution.mjs [--root path]

Checks Plugin P1 scan/write paths for bare WorkspaceResolver.fromProject calls.
Use // @scope-singleroot(permanent|temporary) - reason for intentional single-root sites.`);
    return;
  }

  const repoRoot = options.root;
  const sourceRoot = path.join(repoRoot, 'lib');
  const files = walkTypescriptFiles(sourceRoot);
  const violations = files.flatMap((file) => checkFile(repoRoot, file));

  if (violations.length === 0) {
    writeStdout('scope-resolution lint passed');
    return;
  }

  writeStderr('scope-resolution lint failed:');
  for (const violation of violations) {
    writeStderr(
      `- ${violation.repoRelativePath}:${violation.line}: ${violation.message}\n` +
        `  ${violation.snippet}`
    );
  }
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  writeStderr(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
