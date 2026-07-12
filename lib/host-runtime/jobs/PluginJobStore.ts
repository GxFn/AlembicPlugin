import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { projectLocationService } from '../context/ProjectLocationService.js';

export type PluginJobKind = 'bootstrap' | 'rescan';
export type PluginJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface PluginJobRecord {
  id: string;
  kind: PluginJobKind;
  status: PluginJobStatus;
  projectRoot: string;
  dataRoot: string;
  projectId: string | null;
  request: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
  createdByTool?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export class PluginJobStore {
  readonly jobsDir: string;
  readonly location: ReturnType<typeof projectLocationService.resolve>;

  constructor(projectRoot: string) {
    this.location = projectLocationService.resolve(projectRoot);
    this.jobsDir = join(this.location.runtimeDir, 'jobs');
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
  }

  create(input: {
    kind: PluginJobKind;
    request?: Record<string, unknown>;
    createdByTool?: string;
    sessionId?: string;
  }): PluginJobRecord {
    const now = new Date().toISOString();
    const record: PluginJobRecord = {
      id: `${input.kind}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      status: 'queued',
      projectRoot: this.location.projectRoot,
      dataRoot: this.location.dataRoot,
      projectId: this.location.projectId,
      request: input.request ?? {},
      createdByTool: input.createdByTool,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now,
    };
    this.write(record);
    return record;
  }

  get(id: string): PluginJobRecord | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return null;
    }
    const path = join(this.jobsDir, `${id}.json`);
    if (!existsSync(path)) {
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as PluginJobRecord;
      return parsed.id === id ? parsed : null;
    } catch {
      return null;
    }
  }

  list(options: { kind?: PluginJobKind; status?: PluginJobStatus; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    return readdirSync(this.jobsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.get(basename(name, '.json')))
      .filter((job): job is PluginJobRecord => job !== null)
      .filter((job) => !options.kind || job.kind === options.kind)
      .filter((job) => !options.status || job.status === options.status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  markRunning(id: string) {
    return this.update(id, { status: 'running', startedAt: new Date().toISOString() });
  }

  complete(id: string, result: unknown) {
    return this.update(id, {
      status: 'completed',
      result,
      completedAt: new Date().toISOString(),
    });
  }

  fail(id: string, error: unknown) {
    return this.update(id, {
      status: 'failed',
      error: { message: error instanceof Error ? error.message : String(error) },
      completedAt: new Date().toISOString(),
    });
  }

  private update(id: string, patch: Partial<PluginJobRecord>) {
    const current = this.get(id);
    if (!current || ['completed', 'failed', 'cancelled'].includes(current.status)) {
      return current;
    }
    const next = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
    this.write(next);
    return next;
  }

  private write(record: PluginJobRecord) {
    const path = join(this.jobsDir, `${record.id}.json`);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }
}
