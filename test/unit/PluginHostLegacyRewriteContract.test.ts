import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { projectCoreToolOutput } from '../../lib/runtime/mcp/core-tools/output.js';
import {
  PLUGIN_HOST_LEGACY_REWRITE_CANDIDATES,
  summarizePluginHostMcpContracts,
} from '../../lib/runtime/mcp/plugin-host-contracts.js';
import {
  AgentPublicToolResultEnvelopeSchema,
  createAgentPublicToolResultEnvelope,
} from '../../lib/runtime/mcp/public-tools/index.js';
import {
  isTrustedCodexProjectRoot,
  resolveCodexProjectRoot,
  summarizeCodexProjectRootResolution,
} from '../../lib/runtime/ProjectRootResolver.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

describe('Plugin host legacy rewrite D12 contract', () => {
  test('rejects removed legacy public input instead of degrading it', () => {
    const removedLegacyInput = {
      actionKind: 'intent',
      agentHost: 'codex',
      inputSource: 'legacy-compatibility',
      refs: { detailRefs: [] },
      status: 'ready',
      summary: 'Legacy intent path would otherwise be ready.',
      toolName: 'alembic_intent',
    } as const;

    // W2 (MTC-2): alembic_intent is fully removed — its routed schema no longer exists.
    expect(TOOL_SCHEMAS.alembic_intent).toBeUndefined();
    expect(AgentPublicToolResultEnvelopeSchema.safeParse(removedLegacyInput).success).toBe(false);
    expect(() =>
      createAgentPublicToolResultEnvelope(
        removedLegacyInput as unknown as Parameters<typeof createAgentPublicToolResultEnvelope>[0]
      )
    ).toThrow();
  });

  test('records D12 legacy surfaces with owners, cleanup triggers, and validation refs', () => {
    expect(PLUGIN_HOST_LEGACY_REWRITE_CANDIDATES.map((entry) => entry.candidateId)).toEqual([
      'D12-P02',
      'D12-P03',
      'D12-P04',
    ]);
    for (const candidate of PLUGIN_HOST_LEGACY_REWRITE_CANDIDATES) {
      expect(candidate.currentCompatibilityOwner).toMatch(/\S/);
      expect(candidate.cleanupTrigger).toMatch(/\S/);
      expect(candidate.ordinaryOutputAllowed).toBe(false);
      expect(candidate.validationRefs.length).toBeGreaterThan(0);
    }
    expect(summarizePluginHostMcpContracts()).toMatchObject({
      legacyRewriteCandidateCount: 3,
    });
  });

  test('projects no-scope guard legacy blocker into clean diagnostic-only output', () => {
    const projected = projectCoreToolOutput(
      {
        data: {
          blocked: true,
          legacyBoundary: {
            noArgsWholeDiffDisabled: true,
          },
          reasonCode: 'missing-guard-scope',
          required: {
            files: 'explicit task-scoped file list',
          },
        },
        errorCode: 'GUARD_SCOPE_REQUIRED',
        message:
          'Legacy alembic_guard no-args whole-diff review is disabled. Call alembic_code_guard with explicit files or inline code.',
        meta: { legacyCompatibility: true, mode: 'review', tool: 'alembic_guard' },
        success: false,
      },
      'alembic_guard'
    );

    expect(projected).toMatchObject({
      ok: false,
      reasonCode: 'missing-guard-scope',
      required: {
        files: 'explicit task-scoped file list',
      },
      status: 'blocked',
      toolName: 'alembic_guard',
    });
    expect(JSON.stringify(projected)).not.toContain('legacyBoundary');
    expect(JSON.stringify(projected)).not.toContain('legacyCompatibility');
  });

  test('keeps fallback project roots diagnostic-only and untrusted', () => {
    const fallbackRoot = mkdtempSync(join(tmpdir(), 'alembic-d12-fallback-root-'));
    const alembicHome = mkdtempSync(join(tmpdir(), 'alembic-d12-home-'));
    const resolution = resolveCodexProjectRoot({
      env: {
        ALEMBIC_HOME: alembicHome,
        HOME: alembicHome,
        PWD: fallbackRoot,
      },
    });
    const summary = summarizeCodexProjectRootResolution(resolution);

    expect(resolution).toMatchObject({
      rejected: false,
      source: 'PWD',
      trust: 'fallback',
    });
    expect(isTrustedCodexProjectRoot(resolution)).toBe(false);
    expect(summary).toMatchObject({
      rejected: false,
      trust: 'fallback',
    });
    expect(summary.userMessage).toContain('Pass the current workspace directory');
    expect(summary.requiredActions).toContain(
      'Provide the target project root as an absolute path.'
    );
  });
});
