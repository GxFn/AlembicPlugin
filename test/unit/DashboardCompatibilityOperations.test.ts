import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  DASHBOARD_COMPATIBILITY_OPERATION_HANDLERS,
  DASHBOARD_COMPATIBILITY_OPERATION_IDS,
  DASHBOARD_COMPATIBILITY_OPERATION_MANIFESTS,
} from '../../lib/http/compatibility/operations/DashboardCompatibilityOperations.js';
import { executeDashboardCompatibilityOperation } from '../../lib/http/compatibility/operations/dashboard-compatibility-operation.js';

describe('Dashboard compatibility operations', () => {
  it('keeps external dashboard operation ids stable behind compatibility naming', () => {
    expect(DASHBOARD_COMPATIBILITY_OPERATION_IDS).toEqual({
      updateModuleMap: 'dashboard.update_module_map',
      rebuildSemanticIndex: 'dashboard.rebuild_semantic_index',
      scanProject: 'dashboard.scan_project',
      bootstrapProject: 'dashboard.bootstrap_project',
      cancelBootstrap: 'dashboard.cancel_bootstrap',
      rescanProject: 'dashboard.rescan_project',
    });

    const manifestIds = DASHBOARD_COMPATIBILITY_OPERATION_MANIFESTS.map((manifest) => manifest.id);
    expect(manifestIds).toEqual(Object.values(DASHBOARD_COMPATIBILITY_OPERATION_IDS));
    expect(Object.keys(DASHBOARD_COMPATIBILITY_OPERATION_HANDLERS).sort()).toEqual(
      Object.values(DASHBOARD_COMPATIBILITY_OPERATION_IDS).sort()
    );
  });

  it('returns the existing HTTP tool envelope for compatible route dispatch', async () => {
    const updateModuleMap = vi.fn(async () => ({ updated: true }));
    const container = {
      get(name: string) {
        if (name === 'moduleService') {
          return { updateModuleMap };
        }
        throw new Error(`Unexpected service: ${name}`);
      },
    };
    const req = {
      headers: { 'x-session-id': 'session-1' },
      resolvedRole: 'dashboard',
      resolvedUser: 'tester',
    } as unknown as Request;

    const envelope = await executeDashboardCompatibilityOperation(
      container,
      req,
      DASHBOARD_COMPATIBILITY_OPERATION_IDS.updateModuleMap,
      { aggressive: true }
    );

    expect(updateModuleMap).toHaveBeenCalledWith({ aggressive: true });
    expect(envelope).toMatchObject({
      ok: true,
      status: 'success',
      toolId: 'dashboard.update_module_map',
      structuredContent: { updated: true },
    });
    expect(envelope.diagnostics).toMatchObject({
      degraded: false,
      fallbackUsed: false,
    });
    expect(envelope.trust).toMatchObject({
      source: 'internal',
      sanitized: true,
    });
  });
});
