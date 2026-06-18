import {
  attachHostAgentManagedBoundary,
  attachPluginDeterministicBoundary,
  HOST_AGENT_MANAGED_CODE,
  makeHostAgentManagedError,
  PLUGIN_DETERMINISTIC_EXTRACT_CODE,
} from '../../lib/service/module/host-managed-boundary.js';

const removedLegacyManagedField = ['host', 'Managed'].join('');
const legacyBoundaryField = ['legacy', 'Boundary', 'Code'].join('');
const legacyDeterministicField = ['legacy', 'Host', 'Managed'].join('');

describe('Host-managed capability boundary payloads', () => {
  it('exposes host-agent ownership without old Dashboard caller fields', () => {
    const payload = attachHostAgentManagedBoundary({ total: 1 }, 'module-scan');

    expect(payload.hostAgentManaged).toBe(true);
    expect(payload.boundaryCode).toBe(HOST_AGENT_MANAGED_CODE);
    expect(payload.canonicalCode).toBe(HOST_AGENT_MANAGED_CODE);
    expect(payload.managedBy).toBe('codex-host-agent-or-alembic-resident-service');
    expect(payload.localAi).toBe(false);
    expect(payload.localAiProvider).toBe(false);
    expect(payload.pluginAiProvider).toBe(false);
    expect(payload.capabilityBoundary.owner).toBe('codex-host-agent');
    expect(payload).not.toHaveProperty(removedLegacyManagedField);
    expect(payload).not.toHaveProperty(legacyBoundaryField);
    expect(payload.capabilityBoundary).not.toHaveProperty('legacyCode');
  });

  it('marks deterministic Plugin extract responses without implying a local AI provider', () => {
    const payload = attachPluginDeterministicBoundary({ source: 'text' }, 'extract-text');

    expect(payload.deterministicPluginExtract).toBe(true);
    expect(payload.boundaryCode).toBe(PLUGIN_DETERMINISTIC_EXTRACT_CODE);
    expect(payload.canonicalCode).toBe(PLUGIN_DETERMINISTIC_EXTRACT_CODE);
    expect(payload.semanticEnhancementManagedBy).toBe(
      'codex-host-agent-or-alembic-resident-service'
    );
    expect(payload.localAi).toBe(false);
    expect(payload.localAiProvider).toBe(false);
    expect(payload.pluginAiProvider).toBe(false);
    expect(payload.capabilityBoundary.owner).toBe('alembic-plugin');
    expect(payload).not.toHaveProperty(removedLegacyManagedField);
    expect(payload).not.toHaveProperty(legacyDeterministicField);
  });

  it('uses the canonical host-agent code in errors', () => {
    const error = makeHostAgentManagedError('preview required');

    expect(error.code).toBe(HOST_AGENT_MANAGED_CODE);
    expect(error.canonicalCode).toBe(HOST_AGENT_MANAGED_CODE);
    expect(error.boundaryCode).toBe(HOST_AGENT_MANAGED_CODE);
  });
});
