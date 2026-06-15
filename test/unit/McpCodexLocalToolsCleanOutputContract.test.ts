import { CORE_D25_REQUIRED_FAILURE_KINDS, getCoreFailureTaxonomyEntry } from '@alembic/core/shared';
import { describe, expect, test } from 'vitest';
import {
  CODEX_LOCAL_BASE_OUTPUT_FIELD_NAMES,
  CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES,
  CODEX_LOCAL_TOOL_ALLOWED_BUSINESS_FIELD_NAMES,
  CODEX_LOCAL_TOOL_OUTPUT_SCHEMAS,
  findForbiddenCodexLocalOutputField,
} from '../../lib/runtime/mcp/codex-local-tools/output.js';
import {
  getMcpOutputProjector,
  serializeMcpToolResult,
  withMcpOutputSchema,
} from '../../lib/runtime/mcp/output-contract.js';

const expectedCodexLocalToolNames = [
  'alembic_mcp_status',
  'alembic_codex_diagnostics',
  'alembic_mcp_init',
  'alembic_codex_dashboard',
  'alembic_mcp_bootstrap_job',
  'alembic_mcp_rescan_job',
  'alembic_codex_job',
  'alembic_codex_stop',
  'alembic_codex_cleanup',
] as const;

describe('MCP Codex local tools clean output contract', () => {
  test('registers output schemas for every P4 Codex local tool', () => {
    expect(CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES).toEqual(expectedCodexLocalToolNames);

    for (const toolName of CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES) {
      expect(getMcpOutputProjector(toolName)).toMatchObject({
        outputSchemaName: `${toolName}_clean_output`,
        projectorName: 'codex-local-clean-output-projector',
      });
      expect(withMcpOutputSchema({ name: toolName })).toHaveProperty('outputSchema');
    }
  });

  test('exposes explicit tool-specific outputSchema fields without a generic data bag', () => {
    const baseFields = new Set<string>(CODEX_LOCAL_BASE_OUTPUT_FIELD_NAMES);

    for (const toolName of CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES) {
      const outputSchema = withMcpOutputSchema({ name: toolName }).outputSchema as
        | { additionalProperties?: unknown; properties?: Record<string, unknown> }
        | undefined;
      const properties = outputSchema?.properties ?? {};
      const businessFields = CODEX_LOCAL_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName];

      for (const fieldName of [...CODEX_LOCAL_BASE_OUTPUT_FIELD_NAMES, ...businessFields]) {
        expect(properties).toHaveProperty(fieldName);
      }
      expect(Object.keys(properties).some((fieldName) => !baseFields.has(fieldName))).toBe(true);
      expect(outputSchema?.additionalProperties).not.toEqual(true);
      expect(properties).not.toHaveProperty('data');
      expect(properties).not.toHaveProperty('success');
      expect(properties).not.toHaveProperty('errorCode');
    }
  });

  test('projects legacy Codex local envelopes into clean structuredContent', () => {
    for (const toolName of CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES) {
      const legacy = sampleLegacyEnvelope(toolName);
      const result = serializeMcpToolResult(toolName, legacy, {
        isErrorResult: (value) =>
          !!value &&
          typeof value === 'object' &&
          (value as { success?: unknown }).success === false,
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(result.content).toEqual([{ type: 'text', text: structured.summary }]);
      expect(structured).toMatchObject({
        ok: legacy.success,
        summary: expect.any(String),
        toolName,
        meta: {
          contractVersion: 1,
          outputSchema: `${toolName}_clean_output`,
          projector: 'codex-local-clean-output-projector',
          toolName,
        },
      });
      expect(structured).not.toHaveProperty('data');
      expect(structured).not.toHaveProperty('errorCode');
      expect(structured).not.toHaveProperty('message');
      expect(structured).not.toHaveProperty('result');
      expect(structured).not.toHaveProperty('success');
      expect(structured).not.toHaveProperty('unexpectedContractLeak');
      expect(structured).not.toHaveProperty('value');
      expect(topLevelFieldsAreWhitelisted(toolName, structured)).toEqual([]);
      expect(findForbiddenCodexLocalOutputField(structured, toolName)).toBeNull();
      expect(CODEX_LOCAL_TOOL_OUTPUT_SCHEMAS[toolName].parse(structured)).toEqual(structured);
    }
  });

  test('strips implicit runtime diagnostics from non-diagnostic tools', () => {
    for (const toolName of [
      'alembic_mcp_init',
      'alembic_codex_dashboard',
      'alembic_mcp_bootstrap_job',
      'alembic_mcp_rescan_job',
      'alembic_codex_stop',
    ] as const) {
      const result = serializeMcpToolResult(toolName, sampleLegacyEnvelope(toolName), {
        isErrorResult: () => false,
      });
      const serialized = JSON.stringify(result.structuredContent);

      expect(serialized).not.toContain('projectRuntime');
      expect(serialized).not.toContain('residentService');
      expect(serialized).not.toContain('serviceBoundary');
      expect(serialized).not.toContain('enhancementRoute');
      expect(serialized).not.toContain('hostProjectAlignment');
    }
  });

  test('projects D25 local/provider failure taxonomy into clean ok=false errors', () => {
    for (const failureKind of CORE_D25_REQUIRED_FAILURE_KINDS) {
      const taxonomy = getCoreFailureTaxonomyEntry(failureKind);
      const result = serializeMcpToolResult(
        'alembic_codex_dashboard',
        {
          success: false,
          error: {
            ...taxonomy,
            apiKey: 'must-not-leak',
            code: `CODEX_${failureKind.toUpperCase().replace(/-/g, '_')}`,
            detailRefs: [`codex:${failureKind}`],
            message: `Codex ${failureKind}.`,
            privateDaemonUrl: 'http://127.0.0.1/private',
            providerPrivateTrace: 'must-not-leak',
            secretToken: 'must-not-leak',
          },
          data: {
            needsUserInput: failureKind === 'needs-confirmation',
            nextActions: [{ tool: 'alembic_mcp_status' }],
          },
        },
        {
          isErrorResult: () => true,
        }
      );
      const structured = result.structuredContent as Record<string, unknown>;

      expect(result.isError).toBe(true);
      expect(structured).toMatchObject({
        ok: false,
        error: {
          detailRefs: [`codex:${failureKind}`],
          failureId: taxonomy.stableId,
          failureStatus: taxonomy.status,
          mcpErrorCode: taxonomy.mcpErrorCode,
          mcpStatus: taxonomy.mcpStatus,
          privateDataSafe: true,
          problemClass: taxonomy.problemClass,
          reasonCode: taxonomy.kind,
          refPolicy: taxonomy.refPolicy,
          retryPolicy: taxonomy.retryPolicy,
          retryable: taxonomy.retryable,
        },
      });
      expect(JSON.stringify(structured)).not.toContain('apiKey');
      expect(JSON.stringify(structured)).not.toContain('privateDaemonUrl');
      expect(JSON.stringify(structured)).not.toContain('providerPrivateTrace');
      expect(JSON.stringify(structured)).not.toContain('secretToken');
      expect(findForbiddenCodexLocalOutputField(structured, 'alembic_codex_dashboard')).toBeNull();
    }
  });

  test('rejects already-clean Codex local outputs with non-whitelisted fields', () => {
    const parsed = CODEX_LOCAL_TOOL_OUTPUT_SCHEMAS.alembic_mcp_status.safeParse({
      ok: true,
      status: 'ready',
      summary: 'Status checked.',
      toolName: 'alembic_mcp_status',
      initialized: true,
      unexpectedContractLeak: true,
      meta: { contractVersion: 1, toolName: 'alembic_mcp_status' },
    });

    expect(parsed.success).toBe(false);
  });
});

function topLevelFieldsAreWhitelisted(
  toolName: (typeof CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES)[number],
  structured: Record<string, unknown>
) {
  const allowed = new Set<string>([
    ...CODEX_LOCAL_BASE_OUTPUT_FIELD_NAMES,
    ...CODEX_LOCAL_TOOL_ALLOWED_BUSINESS_FIELD_NAMES[toolName],
  ]);
  return Object.keys(structured).filter((fieldName) => !allowed.has(fieldName));
}

function sampleLegacyEnvelope(toolName: (typeof CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES)[number]) {
  return {
    success: toolName !== 'alembic_codex_dashboard',
    errorCode: toolName === 'alembic_codex_dashboard' ? 'CODEX_DASHBOARD_UNAVAILABLE' : null,
    message: toolName === 'alembic_codex_dashboard' ? 'Dashboard handoff unavailable.' : '',
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
      source: 'unit-sample',
      tool: toolName,
    },
  };
}

function sampleBusinessData(toolName: (typeof CODEX_LOCAL_CLEAN_OUTPUT_TOOL_NAMES)[number]) {
  switch (toolName) {
    case 'alembic_mcp_status':
      return {
        initialized: true,
        projectRoot: '/tmp/project',
        projectRootResolution: { source: 'explicit-option', trust: 'trusted' },
        workspace: { ghost: true },
      };
    case 'alembic_codex_diagnostics':
      return {
        checks: { node: true },
        ok: true,
        package: { pinnedSpecifier: 'alembic-ai@0.0.0' },
        primaryAction: { tool: 'alembic_mcp_status' },
        summary: 'runtime checks passed',
      };
    case 'alembic_mcp_init':
      return {
        mode: 'ghost',
        nextActions: [{ tool: 'alembic_bootstrap' }],
        profile: 'codex',
        results: [],
        status: { initialized: true },
      };
    case 'alembic_codex_dashboard':
      return {
        errorCode: 'CODEX_DASHBOARD_HANDOFF_UNAVAILABLE',
        needsUserInput: true,
        nextActions: [{ tool: 'alembic_mcp_status' }],
      };
    case 'alembic_mcp_bootstrap_job':
      return { job: { id: 'bootstrap-1' }, jobId: 'bootstrap-1' };
    case 'alembic_mcp_rescan_job':
      return { job: { id: 'rescan-1' }, jobId: 'rescan-1' };
    case 'alembic_codex_job':
      return {
        jobRoute: { selected: 'embedded-host-agent-recoverable' },
        jobs: [{ id: 'job-1' }],
      };
    case 'alembic_codex_stop':
      return { daemon: { pidAlive: false, ready: false, status: 'stopped' } };
    case 'alembic_codex_cleanup':
      return {
        dryRun: true,
        targets: { statePath: '/tmp/project/.asd/runtime/daemon.json' },
      };
  }
}
