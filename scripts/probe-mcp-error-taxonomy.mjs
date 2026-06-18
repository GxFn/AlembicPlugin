#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CORE_D25_REQUIRED_FAILURE_KINDS, getCoreFailureTaxonomyEntry } from '@alembic/core/shared';
import '../dist/lib/runtime/mcp/local-tools/output.js';
import '../dist/lib/runtime/mcp/core-tools/output.js';
import { serializeMcpToolResult } from '../dist/lib/runtime/mcp/output-contract.js';

const options = parseArgs(process.argv.slice(2));
const forbiddenKeys = [
  'apiKey',
  'internalTelemetry',
  'privateDaemonUrl',
  'providerPrivateTrace',
  'secretToken',
];
const scenarios = [
  {
    toolName: 'alembic_search',
    source: 'provider-problem',
    business: { query: 'taxonomy', totalResults: 0 },
  },
  {
    toolName: 'alembic_dashboard',
    source: 'codex-local-problem',
    business: { needsUserInput: true, nextActions: [{ tool: 'alembic_status' }] },
  },
];
const calls = [];
const issues = [];

for (const failureKind of CORE_D25_REQUIRED_FAILURE_KINDS) {
  const taxonomy = getCoreFailureTaxonomyEntry(failureKind);
  for (const scenario of scenarios) {
    const result = serializeMcpToolResult(
      scenario.toolName,
      legacyFailureEnvelope({ business: scenario.business, failureKind, taxonomy }),
      {
        isErrorResult: () => true,
      }
    );
    const structured = result.structuredContent ?? {};
    const error = isRecord(structured.error) ? structured.error : {};
    const presentForbiddenKeys = forbiddenKeys.filter((key) => hasKeyDeep(structured, key));
    const missingTaxonomyFields = [
      'failureId',
      'reasonCode',
      'mcpStatus',
      'mcpErrorCode',
      'problemClass',
      'retryPolicy',
      'retryable',
      'refPolicy',
      'exposureClass',
      'detailExposureClass',
      'privateDataSafe',
      'taxonomyVersion',
    ].filter((key) => error[key] === undefined);
    const taxonomyMatches =
      error.failureId === taxonomy.stableId &&
      error.reasonCode === taxonomy.kind &&
      error.mcpStatus === taxonomy.mcpStatus &&
      error.mcpErrorCode === taxonomy.mcpErrorCode &&
      error.problemClass === taxonomy.problemClass &&
      error.retryPolicy === taxonomy.retryPolicy &&
      error.retryable === taxonomy.retryable &&
      error.refPolicy === taxonomy.refPolicy &&
      error.privateDataSafe === true;
    const ok =
      result.isError === true &&
      structured.ok === false &&
      taxonomyMatches &&
      missingTaxonomyFields.length === 0 &&
      presentForbiddenKeys.length === 0;
    const call = {
      ok,
      failureKind,
      source: scenario.source,
      toolName: scenario.toolName,
      summary: typeof structured.summary === 'string' ? structured.summary : null,
      taxonomyMatches,
      missingTaxonomyFields,
      presentForbiddenKeys,
      error: {
        failureId: error.failureId ?? null,
        reasonCode: error.reasonCode ?? null,
        mcpStatus: error.mcpStatus ?? null,
        mcpErrorCode: error.mcpErrorCode ?? null,
        problemClass: error.problemClass ?? null,
        retryPolicy: error.retryPolicy ?? null,
        retryable: error.retryable ?? null,
        refPolicy: error.refPolicy ?? null,
      },
    };
    calls.push(call);
    if (!ok) {
      issues.push(call);
    }
  }
}

const report = {
  ok: issues.length === 0,
  generatedAt: new Date().toISOString(),
  mode: 'mcp-error-taxonomy-probe',
  failureKindCount: CORE_D25_REQUIRED_FAILURE_KINDS.length,
  callCount: calls.length,
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
    `${report.ok ? 'ok' : 'failed'} mcp-error-taxonomy ` +
      `failureKinds=${report.failureKindCount} calls=${report.callCount} issues=${issues.length}\n`
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

function legacyFailureEnvelope({ business, failureKind, taxonomy }) {
  return {
    success: false,
    error: {
      ...taxonomy,
      apiKey: 'must-not-leak',
      code: `D25_${failureKind.toUpperCase().replace(/-/g, '_')}`,
      detailRefs: [`d25:${failureKind}`],
      internalTelemetry: { traceId: 'must-not-leak' },
      message: `D25 ${failureKind}.`,
      privateDaemonUrl: 'http://127.0.0.1/private',
      providerPrivateTrace: 'must-not-leak',
      secretToken: 'must-not-leak',
    },
    data: business,
  };
}

function hasKeyDeep(value, key) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasKeyDeep(item, key));
  }
  const normalized = normalizeKey(key);
  for (const [childKey, childValue] of Object.entries(value)) {
    if (normalizeKey(childKey) === normalized || hasKeyDeep(childValue, key)) {
      return true;
    }
  }
  return false;
}

function normalizeKey(key) {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
