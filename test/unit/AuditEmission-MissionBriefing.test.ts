/**
 * Gap-Fill Tests: M1 (Bootstrap Phase 1.8, MissionBriefing, strategyContext) + M7 (audit:entry)
 *
 * 验证文档与实现差异的补齐代码
 */
import { describe, expect, it, vi } from 'vitest';

/* ═══ 1. AuditLogger audit:entry emission ═══════════════════ */

describe('AuditLogger audit:entry EventBus emission', () => {
  it('emits audit:entry on successful save', async () => {
    const mockEventBus = { emit: vi.fn() };
    const mockStore = {
      save: vi.fn().mockResolvedValue(undefined),
    };

    // Dynamic import to avoid module-level side effects
    const { AuditLogger } = await import('../../lib/infrastructure/audit/AuditLogger.js');
    const logger = new AuditLogger(mockStore as never, mockEventBus);

    await logger.log({
      actor: 'agent',
      action: 'check',
      resource: '/file.ts',
      result: 'success',
    });

    expect(mockStore.save).toHaveBeenCalledOnce();
    expect(mockEventBus.emit).toHaveBeenCalledOnce();
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'audit:entry',
      expect.objectContaining({
        actor: 'agent',
        action: 'check',
        resource: '/file.ts',
        result: 'success',
      })
    );
  });

  it('does not emit when eventBus is null', async () => {
    const mockStore = {
      save: vi.fn().mockResolvedValue(undefined),
    };

    const { AuditLogger } = await import('../../lib/infrastructure/audit/AuditLogger.js');
    const logger = new AuditLogger(mockStore as never);

    await logger.log({
      actor: 'user',
      action: 'create',
      resource: '/test',
      result: 'success',
    });

    expect(mockStore.save).toHaveBeenCalledOnce();
    // No crash — graceful when no eventBus
  });

  it('does not emit when save fails', async () => {
    const mockEventBus = { emit: vi.fn() };
    const mockStore = {
      save: vi.fn().mockRejectedValue(new Error('DB error')),
    };

    const { AuditLogger } = await import('../../lib/infrastructure/audit/AuditLogger.js');
    const logger = new AuditLogger(mockStore as never, mockEventBus);

    // Should not throw
    await logger.log({
      actor: 'agent',
      action: 'create',
      resource: '/test',
      result: 'success',
    });

    // EventBus should NOT be called if save failed
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });
});

/* ═══ 2. MissionBriefingBuilder deleted Panorama boundary ══════════════ */

describe('MissionBriefingBuilder deleted Panorama boundary', () => {
  it('buildMissionBriefing no longer receives or asserts retired Core Panorama content', async () => {
    const { buildMissionBriefing } = await import('@alembic/core/host-agent-workflows');

    const briefing = buildMissionBriefing({
      projectMeta: { name: 'TestProject', fileCount: 100 },
      activeDimensions: [],
      session: { toJSON: () => ({ id: 'test-session' }) },
    });

    expect(JSON.stringify(briefing)).not.toContain('Retired');
    expect(JSON.stringify(briefing)).not.toContain('Legacy');
    expect((briefing as Record<string, unknown>).panorama ?? null).toBeNull();
  });
});
