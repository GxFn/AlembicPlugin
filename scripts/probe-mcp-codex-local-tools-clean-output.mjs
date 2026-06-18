#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CODEX_LOCAL_BASE_OUTPUT_FIELD_NAMES,
  CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES,
  CODEX_LOCAL_RUNTIME_DIAGNOSTIC_TOOL_NAMES,
  CODEX_LOCAL_TOOL_ALLOWED_BUSINESS_FIELD_NAMES,
  findForbiddenCodexLocalOutputField,
} from '../dist/lib/runtime/mcp/local-tools/output.js';
import {
  serializeMcpToolResult,
  withMcpOutputSchema,
} from '../dist/lib/runtime/mcp/output-contract.js';

const options = parseArgs(process.argv.slice(2));
const calls = {};
const issues = [];
const diagnosticTools = new Set(CODEX_LOCAL_RUNTIME_DIAGNOSTIC_TOOL_NAMES);

for (const toolName of CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES) {
  const legacy = sampleLegacyEnvelope(toolName);
  const result = serializeMcpToolResult(toolName, legacy, {
    isErrorResult: (value) => !!value && typeof value === 'object' && value.success === false,
  });
  const structured = result.structuredContent;
  const forbidden = findForbiddenCodexLocalOutputField(structured, toolName);
  const visibleText = result.content?.find((item) => item.type === 'text')?.text ?? null;
  const summary = typeof structured?.summary === 'string' ? structured.summary : null;
  const outputSchema = withMcpOutputSchema({ name: toolName }).outputSchema;
  const outputSchemaProperties = Object.keys(outputSchema?.properties ?? {});
  const businessFields = CODEX_LOCAL_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName] ?? [];
  const baseFields = new Set(CODEX_LOCAL_BASE_OUTPUT_FIELD_NAMES);
  const leakedNonWhitelistedFields = Object.keys(structured ?? {}).filter(
    (fieldName) => !baseFields.has(fieldName) && !businessFields.includes(fieldName)
  );
  const serialized = JSON.stringify(structured ?? {});
  const leaksImplicitRuntimeFields =
    !diagnosticTools.has(toolName) &&
    [
      'projectRuntime',
      'residentService',
      'serviceBoundary',
      'enhancementRoute',
      'hostProjectAlignment',
    ].some((fieldName) => serialized.includes(fieldName));
  const cleanOutput =
    structured?.meta?.contractVersion === 1 &&
    structured?.meta?.outputSchema === `${toolName}_clean_output` &&
    structured?.meta?.projector === 'codex-local-clean-output-projector' &&
    summary !== null &&
    visibleText === summary;
  const omitsLegacyFields =
    structured &&
    !('data' in structured) &&
    !('errorCode' in structured) &&
    !('message' in structured) &&
    !('result' in structured) &&
    !('success' in structured);
  const omitsForbiddenFields = forbidden === null;
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
    leaksImplicitRuntimeFields,
    omitsForbiddenFields,
    omitsLegacyFields,
    omitsNonWhitelistedFields,
    outputSchemaPropertyCount: outputSchemaProperties.length,
    runtimeDiagnosticTool: diagnosticTools.has(toolName),
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
  if (!omitsForbiddenFields) {
    issues.push(`${toolName} returned forbidden field: ${calls[toolName].forbiddenField}`);
  }
  if (!omitsNonWhitelistedFields) {
    issues.push(
      `${toolName} returned non-whitelisted field(s): ${leakedNonWhitelistedFields.join(', ')}`
    );
  }
  if (leaksImplicitRuntimeFields) {
    issues.push(`${toolName} leaked implicit runtime diagnostic fields`);
  }
  if (!hasToolSpecificOutputSchema) {
    issues.push(`${toolName} outputSchema does not expose its tool-specific business fields`);
  }
}

const report = {
  ok: issues.length === 0,
  generatedAt: new Date().toISOString(),
  mode: 'mcp-codex-local-tools-clean-output-projector-probe',
  requiredTools: CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES,
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
    `${report.ok ? 'ok' : 'failed'} mcp-codex-local-tools-clean-output-projector-probe ` +
      `tools=${CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES.length} issues=${issues.length}\n`
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
      enhancementRoute: { selected: 'embedded-host-agent' },
      hostProjectAlignment: { connectionState: 'unavailable' },
      projectRuntime: { identity: { projectRoot: '/tmp/project' } },
      residentService: { ok: false },
      serviceBoundary: { owner: 'alembic-plugin' },
      unexpectedContractLeak: 'must be dropped by the tool whitelist',
    },
    meta: {
      responseTimeMs: 8,
      source: 'probe-sample',
      tool: toolName,
    },
  };
}

function sampleBusinessData(toolName) {
  // MTC-4/7 merged surface: status (health+mcp_status+diagnostics), init,
  // job (bootstrap/rescan/codex_job), runtime (cleanup).
  switch (toolName) {
    case 'alembic_status':
      return {
        initialized: true,
        projectRoot: '/tmp/project',
        projectRootResolution: { source: 'explicit-option', trust: 'trusted' },
        workspace: { ghost: true },
      };
    case 'alembic_init':
      return {
        mode: 'ghost',
        nextActions: [{ tool: 'alembic_bootstrap' }],
        profile: 'codex',
        results: [],
        status: { initialized: true },
      };
    case 'alembic_job':
      return {
        jobRoute: { selected: 'embedded-host-agent-recoverable' },
        jobs: [{ id: 'job-1' }],
      };
    case 'alembic_runtime':
      return { daemon: { pidAlive: false, ready: false, status: 'stopped' } };
  }
}
