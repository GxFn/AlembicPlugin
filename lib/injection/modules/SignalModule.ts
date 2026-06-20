/**
 * SignalModule — Phase 0 信号基础设施注册
 *
 * 注册:
 *   - signalBus:   统一信号总线（基础设施层）
 *   - SignalTraceWriter: unified JSONL signal trace writer
 */

import path from 'node:path';
import { SignalAggregator, SignalBridge, SignalBus, SignalTraceWriter } from '@alembic/core/events';
// RIC-2b: type-import ReportStore from the high-level @alembic/core/report facade
// (not the low-level infrastructure/report). The instance still flows via DI.
import type { ReportStore } from '@alembic/core/report';
import { resolveDataRoot } from '@alembic/core/workspace';
import { shutdown } from '../../shared/shutdown.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  // ═══ Infrastructure ═══

  c.singleton('signalBus', () => new SignalBus());

  // ═══ SignalBridge — SignalBus → EventBus 桥接 ═══

  c.singleton('signalBridge', (ct: ServiceContainer) => {
    const bus = ct.get('signalBus') as SignalBus;
    const eventBus = ct.get('eventBus') as import('@alembic/core/events').EventBus;
    return new SignalBridge(bus, eventBus);
  });

  // ═══ SignalTraceWriter — 全类型信号 JSONL 留痕 ═══

  c.singleton('signalTraceWriter', (ct: ServiceContainer) => {
    const bus = ct.get('signalBus') as SignalBus;
    const root = resolveDataRoot(ct);
    const wz = ct.get('writeZone') as import('@alembic/core/io').WriteZone | null;
    return new SignalTraceWriter(bus, path.join(root, '.asd', 'logs', 'signals'), wz ?? undefined);
  });

  // ═══ SignalAggregator — 滑窗统计 + 异常检测 ═══

  c.singleton('signalAggregator', (ct: ServiceContainer) => {
    const bus = ct.get('signalBus') as SignalBus;
    const reportStore = ct.get('reportStore') as ReportStore;
    const agg = new SignalAggregator(bus, reportStore);
    agg.start();

    shutdown.register(async () => {
      agg.stop();
    }, 'signalAggregator');

    return agg;
  });
}
