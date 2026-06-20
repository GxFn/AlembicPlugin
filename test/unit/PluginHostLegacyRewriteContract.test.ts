import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  PLUGIN_HOST_LEGACY_REWRITE_CANDIDATES,
  summarizePluginHostMcpContracts,
} from '../../lib/runtime/mcp/plugin-host-contracts.js';
import {
  AgentPublicToolResultEnvelopeSchema,
  createAgentPublicToolResultEnvelope,
} from '../../lib/runtime/mcp/public-tools/index.js';
import {
  isTrustedProjectRoot,
  resolveProjectRootFromEnv,
  summarizeProjectRootResolution,
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
      legacyRewriteCandidateCount: 2,
    });
  });

  test('keeps fallback project roots diagnostic-only and untrusted', () => {
    const fallbackRoot = mkdtempSync(join(tmpdir(), 'alembic-d12-fallback-root-'));
    const alembicHome = mkdtempSync(join(tmpdir(), 'alembic-d12-home-'));
    const resolution = resolveProjectRootFromEnv({
      env: {
        ALEMBIC_HOME: alembicHome,
        HOME: alembicHome,
        PWD: fallbackRoot,
      },
    });
    const summary = summarizeProjectRootResolution(resolution);

    expect(resolution).toMatchObject({
      rejected: false,
      source: 'PWD',
      trust: 'fallback',
    });
    expect(isTrustedProjectRoot(resolution)).toBe(false);
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
