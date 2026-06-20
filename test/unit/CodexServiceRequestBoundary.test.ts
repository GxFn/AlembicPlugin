import { describe, expect, it } from 'vitest';
import { resolveServiceRequestBoundary } from '../../lib/runtime/ServiceRequestBoundary.js';

describe('Codex service request boundary', () => {
  it('keeps retired alembic_task direct calls fail-closed in AlembicPlugin', () => {
    for (const operation of ['prime', 'create', 'close', 'fail', 'record_decision']) {
      expect(resolveServiceRequestBoundary('alembic_task', { operation })).toMatchObject({
        executionPath: 'plugin-owned-codex-facing',
        operation,
        owner: 'alembic-plugin',
        residentServiceRequested: false,
        tool: 'alembic_task',
      });
    }
  });

  it('keeps retired alembic_task validation errors in AlembicPlugin', () => {
    expect(resolveServiceRequestBoundary('alembic_task', { operation: 'unknown' })).toMatchObject({
      executionPath: 'plugin-owned-codex-facing',
      operation: 'unknown',
      owner: 'alembic-plugin',
      residentServiceRequested: false,
      tool: 'alembic_task',
    });
  });

  it('keeps Codex-facing search in AlembicPlugin and marks resident service API usage', () => {
    expect(resolveServiceRequestBoundary('alembic_search', {})).toMatchObject({
      executionPath: 'plugin-owned-codex-facing',
      owner: 'alembic-plugin',
      residentServiceRequested: true,
      tool: 'alembic_search',
    });
  });

  it('marks the recoverable job tool as an explicit resident service request', () => {
    // PDR-3: alembic_dashboard tool removed; alembic_job remains the resident
    // service request surface alongside alembic_search.
    expect(resolveServiceRequestBoundary('alembic_job', {})).toMatchObject({
      executionPath: 'plugin-owned-codex-facing',
      owner: 'alembic-plugin',
      residentServiceRequested: true,
      tool: 'alembic_job',
    });
  });

  it('keeps other Codex-facing tools in AlembicPlugin after removing the MCP bridge', () => {
    expect(resolveServiceRequestBoundary('alembic_status', {})).toMatchObject({
      executionPath: 'plugin-owned-codex-facing',
      owner: 'alembic-plugin',
      residentServiceRequested: false,
      tool: 'alembic_status',
    });
  });
});
