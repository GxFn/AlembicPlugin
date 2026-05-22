import {
  attachHostAgentManagedBoundary,
  attachPluginDeterministicBoundary,
  HOST_AGENT_MANAGED_CODE,
  LEGACY_HOST_AI_MANAGED_CODE,
  makeHostAgentManagedError,
  PLUGIN_DETERMINISTIC_EXTRACT_CODE,
} from '../../lib/http/utils/host-managed-boundary.js';

describe('Host-managed capability boundary payloads', () => {
  it('keeps legacy HOST_AI_MANAGED compatibility while exposing a canonical owner', () => {
    const payload = attachHostAgentManagedBoundary({ total: 1 }, 'candidate-enrich');

    expect(payload.hostManaged).toBe(true);
    expect(payload.boundaryCode).toBe(HOST_AGENT_MANAGED_CODE);
    expect(payload.canonicalCode).toBe(HOST_AGENT_MANAGED_CODE);
    expect(payload.legacyBoundaryCode).toBe(LEGACY_HOST_AI_MANAGED_CODE);
    expect(payload.localAi).toBe(false);
    expect(payload.localAiProvider).toBe(false);
    expect(payload.pluginAiProvider).toBe(false);
    expect(payload.capabilityBoundary.owner).toBe('codex-host-agent');
    expect(payload.capabilityBoundary.legacyCode).toBe(LEGACY_HOST_AI_MANAGED_CODE);
  });

  it('marks deterministic Plugin extract responses without implying a local AI provider', () => {
    const payload = attachPluginDeterministicBoundary({ source: 'text' }, 'extract-text');

    expect(payload.hostManaged).toBe(true);
    expect(payload.boundaryCode).toBe(PLUGIN_DETERMINISTIC_EXTRACT_CODE);
    expect(payload.canonicalCode).toBe(PLUGIN_DETERMINISTIC_EXTRACT_CODE);
    expect(payload.legacyHostManaged).toBe(true);
    expect(payload.localAi).toBe(false);
    expect(payload.localAiProvider).toBe(false);
    expect(payload.pluginAiProvider).toBe(false);
    expect(payload.capabilityBoundary.owner).toBe('alembic-plugin');
  });

  it('keeps the old error code and adds canonicalCode for new consumers', () => {
    const error = makeHostAgentManagedError('preview required');

    expect(error.code).toBe(LEGACY_HOST_AI_MANAGED_CODE);
    expect(error.canonicalCode).toBe(HOST_AGENT_MANAGED_CODE);
    expect(error.boundaryCode).toBe(HOST_AGENT_MANAGED_CODE);
  });
});
