#!/usr/bin/env node
import { checkRecipeLoopEvidence } from './lib/codex-recipe-loop-evidence-checker.mjs';

const args = process.argv.slice(2);
const projectRoot = readOption(args, '--project-root');
const transcriptPath = readOption(args, '--transcript');
const reportPath = readOption(args, '--report');
const dimensionId = readOption(args, '--dimension') || 'architecture';

if (!projectRoot) {
  process.stderr.write('--project-root is required\n');
  process.exit(2);
}

try {
  const report = checkRecipeLoopEvidence({
    dimensionId,
    projectRoot,
    reportPath,
    transcriptPath,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

function readOption(values, name) {
  const index = values.indexOf(name);
  if (index < 0) {
    return '';
  }
  return values[index + 1] || '';
}
