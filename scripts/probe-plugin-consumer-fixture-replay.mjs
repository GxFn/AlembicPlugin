#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '../dist/lib/codex/mcp/codex-local-tools/output.js';
import '../dist/lib/codex/mcp/core-tools/output.js';
import {
  serializeMcpToolResult,
  withMcpOutputSchema,
} from '../dist/lib/codex/mcp/output-contract.js';
import {
  PLUGIN_HOST_D24_CONSUMER_REPLAY_SCENARIOS,
  PLUGIN_HOST_RESIDENT_PROVIDER_FIXTURE_REPLAY,
} from '../dist/lib/codex/mcp/plugin-host-contracts.js';

const options = parseArgs(process.argv.slice(2));
const acceptedFixtureIds = new Set(
  PLUGIN_HOST_RESIDENT_PROVIDER_FIXTURE_REPLAY.flatMap((entry) => entry.fixtureIds)
);
const scenarios = [];
const issues = [];

for (const scenario of PLUGIN_HOST_D24_CONSUMER_REPLAY_SCENARIOS) {
  const legacyEnvelope = providerFixtureEnvelope(scenario.providerFixtureId);
  const result = serializeMcpToolResult(scenario.toolName, legacyEnvelope, {
    isErrorResult: (value) => !!value && typeof value === 'object' && value.success === false,
  });
  const structured = result.structuredContent ?? {};
  const visibleText = result.content?.find((item) => item.type === 'text')?.text ?? null;
  const outputSchema = withMcpOutputSchema({ name: scenario.toolName }).outputSchema;
  const missingExpectedFields = scenario.expectedFields.filter(
    (fieldPath) => readPath(structured, fieldPath) === undefined
  );
  const presentForbiddenFields = scenario.forbiddenOrdinaryOutputFields.filter((fieldName) =>
    hasKeyDeep(structured, fieldName)
  );
  const legacyEnvelopeFields = ['data', 'errorCode', 'message', 'result', 'success'].filter(
    (fieldName) => Object.hasOwn(structured, fieldName)
  );
  const hasToolSpecificOutputSchema =
    !!outputSchema &&
    outputSchema.additionalProperties !== true &&
    scenario.expectedFields
      .map((fieldPath) => fieldPath.split('.')[0])
      .every((fieldName) => outputSchema.properties?.[fieldName]);
  const cleanOutput =
    structured?.meta?.contractVersion === 1 &&
    structured?.meta?.outputSchema === `${scenario.toolName}_clean_output` &&
    typeof structured.summary === 'string' &&
    visibleText === structured.summary &&
    structured.toolName === scenario.toolName;
  const scenarioIssues = [];

  if (!acceptedFixtureIds.has(scenario.providerFixtureId)) {
    scenarioIssues.push({
      owner: scenario.failureClassification.missingFixtureOwner,
      reason: 'provider fixture id is not registered as accepted replay evidence',
      fields: [scenario.providerFixtureId],
    });
  }
  if (missingExpectedFields.length > 0) {
    scenarioIssues.push({
      owner: scenario.failureClassification.missingExpectedFieldOwner,
      reason: 'Plugin consumer expected fields are missing after projection',
      fields: missingExpectedFields,
    });
  }
  if (presentForbiddenFields.length > 0) {
    scenarioIssues.push({
      owner: scenario.failureClassification.forbiddenFieldOwner,
      reason: 'Forbidden diagnostic/private/sensitive fields reached structuredContent',
      fields: presentForbiddenFields,
    });
  }
  if (legacyEnvelopeFields.length > 0) {
    scenarioIssues.push({
      owner: 'plugin-mcp-projection',
      reason: 'Legacy transport envelope fields reached structuredContent',
      fields: legacyEnvelopeFields,
    });
  }
  if (!cleanOutput) {
    scenarioIssues.push({
      owner: 'plugin-mcp-projection',
      reason: 'Projected output is not clean summary-only MCP structuredContent',
      fields: ['summary', 'meta.outputSchema', 'toolName'],
    });
  }
  if (!hasToolSpecificOutputSchema) {
    scenarioIssues.push({
      owner: 'plugin-mcp-projection',
      reason: 'MCP tools/list outputSchema is missing consumer-needed fields',
      fields: scenario.expectedFields,
    });
  }

  const entry = {
    ok: scenarioIssues.length === 0,
    cleanOutput,
    consumerScenario: scenario.consumerScenario,
    expectedFields: scenario.expectedFields,
    failureClassification: scenario.failureClassification,
    forbiddenOrdinaryOutputFields: scenario.forbiddenOrdinaryOutputFields,
    hasToolSpecificOutputSchema,
    missingExpectedFields,
    presentForbiddenFields,
    producerContract: scenario.producerContract,
    providerFixtureAccepted: acceptedFixtureIds.has(scenario.providerFixtureId),
    providerFixtureId: scenario.providerFixtureId,
    registryRowId: scenario.registryRowId,
    status: structured.status ?? null,
    summary: typeof structured.summary === 'string' ? structured.summary : null,
    toolName: scenario.toolName,
    unexpectedLegacyEnvelopeFields: legacyEnvelopeFields,
    issues: scenarioIssues,
  };
  scenarios.push(entry);
  issues.push(
    ...scenarioIssues.map((issue) => ({
      consumerScenario: scenario.consumerScenario,
      owner: issue.owner,
      reason: issue.reason,
      fields: issue.fields,
    }))
  );
}

const report = {
  ok: issues.length === 0,
  generatedAt: new Date().toISOString(),
  mode: 'plugin-consumer-driven-provider-fixture-replay',
  replayScenarioCount: scenarios.length,
  scenarios,
  issues,
};

if (options.reportPath) {
  writeFileSync(resolve(options.reportPath), `${JSON.stringify(report, null, 2)}\n`);
}
if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    `${report.ok ? 'ok' : 'failed'} plugin-consumer-driven-provider-fixture-replay ` +
      `scenarios=${scenarios.length} issues=${issues.length}\n`
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

function providerFixtureEnvelope(fixtureId) {
  return {
    success: true,
    data: {
      ...providerFixtureBusinessData(fixtureId),
      apiKey: 'api-key-must-not-leak',
      diagnostics: {
        internalTelemetry: { providerPrivateTrace: 'diagnostic-trace-must-not-leak' },
        reason: 'fixture diagnostic field',
        secretToken: 'diagnostic-token-must-not-leak',
      },
      internalTelemetry: { providerPrivateTrace: 'top-level-telemetry-must-not-leak' },
      privateDaemonUrl: 'http://127.0.0.1:65535/private',
      providerPrivateTrace: 'provider-trace-must-not-leak',
      secretToken: 'secret-token-must-not-leak',
      telemetry: { durationMs: 7 },
    },
    meta: {
      responseTimeMs: 12,
      source: 'd24-provider-fixture-replay',
      tool: fixtureId,
    },
  };
}

function providerFixtureBusinessData(fixtureId) {
  switch (fixtureId) {
    case 'runtime-health.ready':
      return {
        checks: { database: true, resident: true },
        services: { daemon: 'ready' },
        status: 'ok',
        version: '0.2.0',
      };
    case 'knowledge.success':
      return {
        items: [{ id: 'knowledge-alpha', kind: 'rule', title: 'Boundary rule' }],
        kindCounts: { rule: 1 },
        query: 'Boundary rule',
        searchMeta: { residentSearch: { used: true, providerPrivateTrace: 'search-trace' } },
        totalResults: 1,
      };
    case 'runtime-health.partial':
      return {
        initialized: true,
        projectRoot: '/tmp/d24-plugin-project',
        projectRuntime: {
          identity: {
            projectRoot: '/tmp/d24-plugin-project',
            runtimeDir: '/tmp/d24-plugin-project/.asd',
          },
          privateDaemonUrl: 'http://127.0.0.1:65535/private',
          secretToken: 'runtime-token-must-not-leak',
          sourcePolicy: {
            effectiveIdentitySource: 'codex-current-project',
          },
        },
        workspace: { ghost: true },
      };
    case 'jobs.queued':
      return {
        jobRoute: { selected: 'resident-or-embedded-jobs' },
        jobs: [{ id: 'job-bootstrap-1', kind: 'bootstrap', status: 'queued' }],
        projectRuntime: {
          identity: {
            projectRoot: '/tmp/d24-plugin-project',
            runtimeDir: '/tmp/d24-plugin-project/.asd',
          },
          privateDaemonUrl: 'http://127.0.0.1:65535/private',
          secretToken: 'job-token-must-not-leak',
        },
      };
    default:
      return {};
  }
}

function readPath(value, path) {
  return path.split('.').reduce((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return current[segment];
  }, value);
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
