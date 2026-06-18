import { describe, expect, it } from 'vitest';
import { resolveCodexServiceRequestBoundary } from '../../lib/runtime/ServiceRequestBoundary.js';

describe('Codex service request boundary', () => {
  it('keeps retired alembic_task direct calls fail-closed in AlembicPlugin', () => {
    for (const operation of ['prime', 'create', 'close', 'fail', 'record_decision']) {
      expect(resolveCodexServiceRequestBoundary('alembic_task', { operation })).toMatchObject({
        executionPath: 'plugin-owned-codex-facing',
        operation,
        owner: 'alembic-plugin',
        residentServiceRequested: false,
        tool: 'alembic_task',
      });
    }
  });

  it('keeps retired alembic_task validation errors in AlembicPlugin', () => {
    expect(
      resolveCodexServiceRequestBoundary('alembic_task', { operation: 'unknown' })
    ).toMatchObject({
      executionPath: 'plugin-owned-codex-facing',
      operation: 'unknown',
      owner: 'alembic-plugin',
      residentServiceRequested: false,
      tool: 'alembic_task',
    });
  });

  it('keeps Codex-facing search in AlembicPlugin and marks resident service API usage', () => {
    expect(resolveCodexServiceRequestBoundary('alembic_search', {})).toMatchObject({
      executionPath: 'plugin-owned-codex-facing',
      owner: 'alembic-plugin',
      residentServiceRequested: true,
      tool: 'alembic_search',
    });
  });

  it('marks dashboard and recoverable job tools as explicit resident service requests', () => {
    for (const tool of ['alembic_codex_dashboard', 'alembic_job']) {
      expect(resolveCodexServiceRequestBoundary(tool, {})).toMatchObject({
        executionPath: 'plugin-owned-codex-facing',
        owner: 'alembic-plugin',
        residentServiceRequested: true,
        tool,
      });
    }
  });

  it('keeps other Codex-facing tools in AlembicPlugin after removing the MCP bridge', () => {
    expect(resolveCodexServiceRequestBoundary('alembic_status', {})).toMatchObject({
      executionPath: 'plugin-owned-codex-facing',
      owner: 'alembic-plugin',
      residentServiceRequested: false,
      tool: 'alembic_status',
    });
  });
});
