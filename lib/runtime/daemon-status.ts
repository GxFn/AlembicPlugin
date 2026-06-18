import type { DaemonState } from '@alembic/core/daemon';

// PDR-3: this daemon status shape was relocated here when the embedded runtime
// carrier was removed. It survives as the type the status / diagnostics /
// enhancement-route / resident consumers reference — now always resolved to a
// daemon-less (null / 'stopped') value at runtime. PDR-4 (resident slim) and PDR-5
// (enhancement-route rewrite) own any further reduction of these consumers; PDR-3
// only re-homes the type.
export type DaemonStatusKind = 'ready' | 'starting' | 'stopped' | 'stale' | 'failed';

export interface DaemonStatus {
  status: DaemonStatusKind;
  ready: boolean;
  projectRoot: string;
  dataRoot: string;
  projectId: string | null;
  statePath: string;
  pidPath: string;
  lockDir: string;
  logPath: string;
  state: DaemonState | null;
  pidAlive: boolean;
  health: Record<string, unknown> | null;
  message?: string;
}
