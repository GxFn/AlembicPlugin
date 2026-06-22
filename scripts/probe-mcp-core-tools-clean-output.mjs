#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CORE_BASE_OUTPUT_FIELD_NAMES,
  CORE_CLEAN_OUTPUT_TOOL_NAMES,
  CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES,
  findForbiddenCoreOutputField,
} from '../dist/lib/runtime/mcp/core-tools/output.js';
import {
  serializeMcpToolResult,
  withMcpOutputSchema,
} from '../dist/lib/runtime/mcp/output-contract.js';

const options = parseArgs(process.argv.slice(2));
const calls = {};
const issues = [];

for (const toolName of CORE_CLEAN_OUTPUT_TOOL_NAMES) {
  const legacy = sampleLegacyEnvelope(toolName);
  const result = serializeMcpToolResult(toolName, legacy, {
    isErrorResult: (value) => !!value && typeof value === 'object' && value.success === false,
  });
  const structured = result.structuredContent;
  const forbidden = findForbiddenCoreOutputField(structured);
  const visibleText = result.content?.find((item) => item.type === 'text')?.text ?? null;
  const summary = typeof structured?.summary === 'string' ? structured.summary : null;
  const outputSchema = withMcpOutputSchema({ name: toolName }).outputSchema;
  const outputSchemaProperties = Object.keys(outputSchema?.properties ?? {});
  const businessFields = CORE_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName] ?? [];
  const baseFields = new Set(CORE_BASE_OUTPUT_FIELD_NAMES);
  const leakedNonWhitelistedFields = Object.keys(structured ?? {}).filter(
    (fieldName) => !baseFields.has(fieldName) && !businessFields.includes(fieldName)
  );
  const cleanOutput =
    structured?.meta?.contractVersion === 1 &&
    structured?.meta?.outputSchema === `${toolName}_clean_output` &&
    structured?.meta?.projector === 'core-tools-clean-output-projector' &&
    summary !== null &&
    visibleText === summary;
  const omitsLegacyFields =
    structured &&
    !('data' in structured) &&
    !('errorCode' in structured) &&
    !('message' in structured) &&
    !('result' in structured) &&
    !('success' in structured);
  const omitsDiagnosticFields = forbidden === null;
  const omitsNonWhitelistedFields = leakedNonWhitelistedFields.length === 0;
  const hasToolSpecificOutputSchema =
    businessFields.length > 0 &&
    businessFields.every((fieldName) => outputSchemaProperties.includes(fieldName)) &&
    outputSchemaProperties.some((fieldName) => !baseFields.has(fieldName)) &&
    outputSchema?.additionalProperties !== true;

  calls[toolName] = {
    cleanOutput,
    businessFieldCount: businessFields.length,
    forbiddenField: forbidden?.path?.join('.') ?? null,
    hasToolSpecificOutputSchema,
    isError: result.isError === true,
    omitsDiagnosticFields,
    omitsLegacyFields,
    omitsNonWhitelistedFields,
    outputSchemaPropertyCount: outputSchemaProperties.length,
    status: structured?.status ?? null,
    summary,
    unexpectedFields: leakedNonWhitelistedFields,
  };

  if (!cleanOutput) {
    issues.push(`${toolName} did not return clean structuredContent with summary-only text`);
  }
  if (!omitsLegacyFields) {
    issues.push(`${toolName} returned old success/errorCode/message/data/result envelope fields`);
  }
  if (!omitsDiagnosticFields) {
    issues.push(`${toolName} returned forbidden field: ${calls[toolName].forbiddenField}`);
  }
  if (!omitsNonWhitelistedFields) {
    issues.push(
      `${toolName} returned non-whitelisted field(s): ${leakedNonWhitelistedFields.join(', ')}`
    );
  }
  if (!hasToolSpecificOutputSchema) {
    issues.push(`${toolName} outputSchema does not expose its tool-specific business fields`);
  }
}

const report = {
  ok: issues.length === 0,
  generatedAt: new Date().toISOString(),
  mode: 'mcp-core-tools-clean-output-projector-probe',
  requiredTools: CORE_CLEAN_OUTPUT_TOOL_NAMES,
  calls,
  issues,
};

if (options.reportPath) {
  writeFileSync(resolve(options.reportPath), `${JSON.stringify(report, null, 2)}\n`);
}
if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    `${report.ok ? 'ok' : 'failed'} mcp-core-tools-clean-output-projector-probe ` +
      `tools=${CORE_CLEAN_OUTPUT_TOOL_NAMES.length} issues=${issues.length}\n`
  );
}
if (!report.ok) {
  process.exitCode = 1;
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

function sampleLegacyEnvelope(toolName) {
  return {
    success: true,
    errorCode: null,
    message: '',
    data: {
      ...sampleBusinessData(toolName),
      diagnostics: { traceId: 'diag-1' },
      metadata: { internal: true },
      projectRuntime: { runtimeDir: '/tmp/not-public' },
      runtimePolicy: { route: 'internal' },
      searchMeta: { residentSearch: { used: true } },
      sourcePolicy: { owner: 'internal' },
      telemetry: { durationMs: 7 },
      temporaryCompatibilityBag: { stale: true },
      unexpectedContractLeak: 'must be dropped by the tool whitelist',
    },
    meta: {
      responseTimeMs: 7,
      source: 'probe-sample',
      tool: toolName,
    },
  };
}

function sampleBusinessData(toolName) {
  switch (toolName) {
    case 'alembic_status':
      return { checks: { database: true }, status: 'ok', version: '0.0.0' };
    case 'alembic_knowledge':
      return { count: 0, items: [], total: 0 };
    case 'alembic_structure':
      return { summary: { targetCount: 1 }, targets: [{ name: 'App' }] };
    case 'alembic_graph':
      return { impacted: [], impactedCount: 0, nodeId: 'recipe-1' };
    case 'alembic_call_context':
      return { callees: [], callers: [], methodName: 'run' };
    case 'alembic_submit_knowledge':
      return { count: 1, ids: ['recipe-1'], total: 1 };
    case 'alembic_project_skill':
      return { operation: 'list', skills: [] };
    case 'alembic_bootstrap':
      return { dimensions: [], executionPlan: [] };
    case 'alembic_rescan':
      return { allRecipes: [], dimensions: [], executionPlan: [] };
    case 'alembic_evolve':
      return { processed: 1, proposed: 0, refreshed: 1 };
    case 'alembic_consolidate':
      return { kept: 1, merged: 0, processed: 1, rejected: 0 };
    case 'alembic_dimension_complete':
      return { completed: true, dimensionId: 'architecture' };
    case 'alembic_knowledge_lifecycle':
      return { action: 'reactivate', updated: 1 };
    default:
      return {};
  }
}
