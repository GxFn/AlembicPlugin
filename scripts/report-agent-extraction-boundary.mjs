#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_ROOTS = ['lib', 'bin', 'scripts', 'test'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const IGNORED_DIRS = new Set(['.git', 'coverage', 'dist', 'node_modules', 'vendor']);

const IMPORT_PATTERNS = [
  /\b(?:import|export)\s+(?:type\s+)?[^;]*?\s+from\s*['"]([^'"]+)['"]/g,
  /\b(?:import|export)\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const args = process.argv.slice(2);
const format = readOption(args, '--format') || 'json';
const rootsOption = readOption(args, '--roots');
const roots = rootsOption ? rootsOption.split(',').filter(Boolean) : DEFAULT_ROOTS;
const workspaceRoot = process.cwd();

if (!['json', 'markdown'].includes(format)) {
  throw new Error(`Unsupported --format value: ${format}`);
}

const report = buildReport(workspaceRoot, roots);

if (format === 'markdown') {
  process.stdout.write(formatMarkdown(report));
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function buildReport(root, scanRoots) {
  const files = scanRoots.flatMap((scanRoot) => collectFiles(path.resolve(root, scanRoot), root));
  const records = files
    .map((file) => collectBoundaryImports(file, root))
    .filter((record) => record.specifiers.length > 0);

  const agentFiles = records.filter((record) =>
    record.specifiers.some((specifier) => specifier.startsWith('#agent/'))
  );
  const aiFiles = records.filter((record) =>
    record.specifiers.some((specifier) => specifier.startsWith('#external/ai'))
  );
  const toolFiles = records.filter((record) =>
    record.specifiers.some((specifier) => specifier.startsWith('#tools/'))
  );

  const agentOutsideImplementation = filterOutside(agentFiles, 'lib/agent/');
  const aiOutsideImplementation = filterOutside(aiFiles, 'lib/external/ai/');
  const toolOutsideImplementation = filterOutside(toolFiles, 'lib/tools/');

  return {
    generatedAt: new Date().toISOString(),
    scanRoots,
    summary: {
      sourceFilesScanned: files.length,
      filesWithBoundaryImports: records.length,
      agentImportFiles: agentFiles.length,
      agentOutsideImplementationFiles: agentOutsideImplementation.length,
      agentOutsideImplementationProductionFiles: agentOutsideImplementation.filter(
        (record) => !record.file.startsWith('test/')
      ).length,
      aiImportFiles: aiFiles.length,
      aiOutsideImplementationFiles: aiOutsideImplementation.length,
      toolImportFiles: toolFiles.length,
      toolOutsideImplementationFiles: toolOutsideImplementation.length,
      toolOutsideImplementationProductionFiles: toolOutsideImplementation.filter(
        (record) => !record.file.startsWith('test/')
      ).length,
    },
    agentOutsideImplementation,
    aiOutsideImplementation,
    toolOutsideImplementation,
  };
}

function collectFiles(root, workspaceRoot) {
  if (!existsSync(root)) {
    return [];
  }

  const files = [];

  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          visit(path.join(current, entry.name));
        }
        continue;
      }
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(
          path.relative(workspaceRoot, path.join(current, entry.name)).replaceAll('\\', '/')
        );
      }
    }
  }

  visit(root);
  return files.sort();
}

function collectBoundaryImports(file, root) {
  const content = readFileSync(path.resolve(root, file), 'utf8');
  const specifiers = new Set();

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(content);
    while (match) {
      const specifier = match[1];
      if (isBoundarySpecifier(specifier)) {
        specifiers.add(specifier);
      }
      match = pattern.exec(content);
    }
  }

  return {
    file,
    specifiers: [...specifiers].sort(),
  };
}

function filterOutside(records, implementationPrefix) {
  return records
    .filter((record) => !record.file.startsWith(implementationPrefix))
    .map((record) => ({
      file: record.file,
      specifiers: record.specifiers.filter((specifier) =>
        specifierForImplementation(specifier, implementationPrefix)
      ),
    }))
    .filter((record) => record.specifiers.length > 0);
}

function specifierForImplementation(specifier, implementationPrefix) {
  if (implementationPrefix === 'lib/agent/') {
    return specifier.startsWith('#agent/');
  }
  if (implementationPrefix === 'lib/external/ai/') {
    return specifier.startsWith('#external/ai');
  }
  return specifier.startsWith('#tools/');
}

function isBoundarySpecifier(specifier) {
  return (
    specifier.startsWith('#agent/') ||
    specifier.startsWith('#external/ai') ||
    specifier.startsWith('#tools/')
  );
}

function formatMarkdown(report) {
  const lines = [
    '| Metric | Count |',
    '| --- | ---: |',
    ...Object.entries(report.summary).map(([key, value]) => `| ${key} | ${value} |`),
    '',
  ];

  appendRecords(lines, 'Agent Imports Outside lib/agent', report.agentOutsideImplementation);
  appendRecords(lines, 'AI Imports Outside lib/external/ai', report.aiOutsideImplementation);
  appendRecords(lines, 'Tool Imports Outside lib/tools', report.toolOutsideImplementation);

  return `${lines.join('\n')}\n`;
}

function appendRecords(lines, title, records) {
  lines.push(`## ${title}`, '', '| File | Specifiers |', '| --- | --- |');
  for (const record of records) {
    lines.push(`| ${record.file} | ${record.specifiers.join('<br>')} |`);
  }
  lines.push('');
}

function readOption(values, name) {
  const index = values.indexOf(name);
  if (index < 0) {
    return '';
  }
  return values[index + 1] || '';
}
