#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodexMcpServer } from '../dist/lib/runtime/mcp/CodexMcpServer.js';
import { serializeMcpToolResult } from '../dist/lib/runtime/mcp/output-contract.js';
import * as toolsModule from '../dist/lib/runtime/mcp/tools.js';
import { TOOL_SCHEMAS } from '../dist/lib/shared/schemas/mcp-tools.js';

const { TOOLS } = toolsModule;

const options = parseArgs(process.argv.slice(2));
const issues = [];

const activeToolNames = TOOLS.map((tool) => tool.name);
// RC4 removed the always-empty LEGACY_DIRECT_CALL_COMPATIBILITY_TOOLS surface;
// the probe now guards against the export coming back.
const legacyCompatibilityExports = Object.keys(toolsModule).filter((name) =>
  name.startsWith('LEGACY_DIRECT_CALL_COMPATIBILITY')
);

if (activeToolNames.includes('alembic_task')) {
  issues.push('alembic_task is still present in active TOOLS');
}
if (legacyCompatibilityExports.length !== 0) {
  issues.push(
    `legacy direct-call compatibility exports reappeared: ${legacyCompatibilityExports.join(', ')}`
  );
}
if (Object.hasOwn(TOOL_SCHEMAS, 'alembic_task')) {
  issues.push('TOOL_SCHEMAS still exposes alembic_task');
}

const server = new CodexMcpServer({ projectRoot: process.cwd() });
const retiredDirectCall = await server.handleToolCall('alembic_task', {
  operation: 'prime',
  userQuery: 'T6 retired direct-call probe',
});
const serializedRetired = serializeMcpToolResult('alembic_task', retiredDirectCall, {
  isErrorResult: (value) => !!value && typeof value === 'object' && value.ok === false,
});
const retiredStructured = serializedRetired.structuredContent ?? {};
const retiredSerialized = JSON.stringify(retiredStructured);
if (
  retiredStructured.ok !== false ||
  retiredStructured.status !== 'retired' ||
  retiredStructured.error?.code !== 'CODEX_TOOL_RETIRED' ||
  serializedRetired.content?.[0]?.text !== retiredStructured.summary ||
  serializedRetired.isError !== true
) {
  issues.push('alembic_task direct call did not serialize as clean retired output');
}
for (const field of ['success', 'errorCode', 'message', 'data', 'result', 'legacyCompatibility']) {
  if (Object.hasOwn(retiredStructured, field)) {
    issues.push(`retired alembic_task output leaked old top-level field ${field}`);
  }
}
for (const field of ['success', 'errorCode', 'data', 'result', 'legacyCompatibility']) {
  if (retiredSerialized.includes(`"${field}"`)) {
    issues.push(`retired alembic_task output leaked old nested field ${field}`);
  }
}

const missingProjector = serializeMcpToolResult(
  't6_unregistered_tool',
  {
    success: true,
    data: {
      result: { legacyCompatibility: { retired: false } },
    },
  },
  {
    isErrorResult: (value) => !!value && typeof value === 'object' && value.success === false,
  }
);
const missingStructured = missingProjector.structuredContent ?? {};
if (
  missingStructured.ok !== false ||
  missingStructured.status !== 'blocked' ||
  missingStructured.error?.code !== 'CLEAN_OUTPUT_PROJECTOR_MISSING' ||
  missingProjector.content?.[0]?.text !== missingStructured.summary ||
  missingProjector.isError !== true
) {
  issues.push('missing clean-output projector did not fail closed as clean structured output');
}

const docs = scanDocs([
  'README.md',
  'README_CN.md',
  'plugins/alembic-codex/README.md',
  'plugins/alembic-codex/README.zh-CN.md',
  'injectable-skills/alembic-create/SKILL.md',
  'injectable-skills/alembic-recipes/SKILL.md',
  'injectable-skills/alembic-guard/SKILL.md',
  'plugins/alembic-codex/skills/alembic/SKILL.md',
  'plugins/alembic-codex/skills/alembic-recipes/SKILL.md',
  'plugins/alembic-codex/skills/alembic-guard/SKILL.md',
  'plugins/alembic-codex/runtime/injectable-skills/alembic-create/SKILL.md',
  'plugins/alembic-codex/runtime/injectable-skills/alembic-recipes/SKILL.md',
  'plugins/alembic-codex/runtime/injectable-skills/alembic-guard/SKILL.md',
  'plugins/alembic-codex/runtime/plugins/alembic-codex/README.md',
  'plugins/alembic-codex/runtime/plugins/alembic-codex/README.zh-CN.md',
  'plugins/alembic-codex/runtime/plugins/alembic-codex/skills/alembic/SKILL.md',
  'plugins/alembic-codex/runtime/plugins/alembic-codex/skills/alembic-recipes/SKILL.md',
  'plugins/alembic-codex/runtime/plugins/alembic-codex/skills/alembic-guard/SKILL.md',
]);
for (const hit of docs.forbiddenHits) {
  issues.push(`${hit.file} contains stale ${hit.pattern}`);
}

const report = {
  ok: issues.length === 0,
  generatedAt: new Date().toISOString(),
  mode: 'mcp-clean-output-final-legacy-docs-cache-probe',
  activeToolNamesIncludeTask: activeToolNames.includes('alembic_task'),
  legacyCompatibilityExports,
  schemaIncludesTask: Object.hasOwn(TOOL_SCHEMAS, 'alembic_task'),
  retiredDirectCall: {
    ok: retiredStructured.ok ?? null,
    status: retiredStructured.status ?? null,
    errorCode: retiredStructured.error?.code ?? null,
    summaryOnlyText: serializedRetired.content?.[0]?.text === retiredStructured.summary,
  },
  missingProjector: {
    ok: missingStructured.ok ?? null,
    status: missingStructured.status ?? null,
    errorCode: missingStructured.error?.code ?? null,
    summaryOnlyText: missingProjector.content?.[0]?.text === missingStructured.summary,
  },
  docs,
  issues,
};

if (options.reportPath) {
  writeFileSync(resolve(options.reportPath), `${JSON.stringify(report, null, 2)}\n`);
}
if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    `${report.ok ? 'ok' : 'failed'} mcp-clean-output-final-legacy-docs-cache-probe ` +
      `issues=${issues.length} docs=${docs.checked.length}\n`
  );
}
if (!report.ok) {
  process.exitCode = 1;
}

function scanDocs(files) {
  const forbiddenPatterns = [
    'unified JSON Envelope',
    'success, errorCode',
    'success/errorCode',
    'Older direct calls may still',
    'Hidden direct-call compatibility',
    'searchMeta.residentSearch',
    'residentVector',
  ];
  const checked = [];
  const missing = [];
  const forbiddenHits = [];
  for (const file of files) {
    const path = resolve(file);
    if (!existsSync(path)) {
      missing.push(file);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    checked.push(file);
    for (const pattern of forbiddenPatterns) {
      if (text.includes(pattern)) {
        forbiddenHits.push({ file, pattern });
      }
    }
  }
  return { checked, forbiddenHits, missing };
}

function parseArgs(args) {
  const out = { json: false, reportPath: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      out.json = true;
    } else if (arg === '--report-path') {
      out.reportPath = args[++i] ?? null;
    }
  }
  return out;
}
