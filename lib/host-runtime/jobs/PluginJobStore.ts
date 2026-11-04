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
import Logger from '@alembic/core/logging';
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
    // 构造与读路径不落盘：未初始化项目的 runtimeDir 就在仓库里（dataRoot == projectRoot），
    // alembic_job op=status 只读也不能在用户仓库里留下 .asd/jobs；目录只在真正写 job 记录时创建。
    this.jobsDir = join(this.location.runtimeDir, 'jobs');
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
    if (!existsSync(this.jobsDir)) {
      // 从未写过 job：等价于空列表，不为读取而创建目录。诊断走 Core Logger（stderr / 日志文件），
      // 便于区分"该项目从未建过 job"与"job 目录被清理/指向了别的 dataRoot"。
      Logger.getInstance().debug(
        '[PluginJobStore] jobs directory does not exist; listing no jobs (directory not created)',
        {
          dataRoot: this.location.dataRoot,
          jobsDir: this.jobsDir,
          kind: options.kind ?? null,
          status: options.status ?? null,
        }
      );
      return [];
    }
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

  /**
   * 标记失败。result 可选：workflow 以结构化失败返回（如 Plan gate 阻断）时一并保存其
   * 业务数据，便于 op=status 回读 nextActions / blockedReason，而不只剩一行 message。
   */
  fail(id: string, error: unknown, result?: unknown) {
    return this.update(id, {
      status: 'failed',
      error: { message: error instanceof Error ? error.message : String(error) },
      ...(result === undefined ? {} : { result }),
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
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    const path = join(this.jobsDir, `${record.id}.json`);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }
}
