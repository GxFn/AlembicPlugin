/**
 * W3a-3 回归：PluginJobStore.list() 在 jobs 目录不存在时返回 []，同时留下诊断日志
 * （Core Logger → stderr / 日志文件，不占 stdout），且绝不为读取创建目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PluginJobStore } from '../../lib/host-runtime/jobs/PluginJobStore.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const createdRoots: string[] = [];

describe('PluginJobStore.list without a jobs directory', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_ALEMBIC_HOME === undefined) {
      delete process.env.ALEMBIC_HOME;
    } else {
      process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
    }
    for (const root of createdRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('returns [] with a diagnostic and does not create the directory', () => {
    process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-jobs-home-'));
    createdRoots.push(process.env.ALEMBIC_HOME);
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-fix-jobs-project-'));
    createdRoots.push(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"jobs"}\n');
    const logger = Logger.getInstance();
    const debug = vi.spyOn(logger, 'debug');
    const info = vi.spyOn(logger, 'info');
    const stdout = vi.spyOn(process.stdout, 'write');

    const store = new PluginJobStore(projectRoot);
    const jobs = store.list({ kind: 'bootstrap' });

    expect(jobs).toEqual([]);
    expect(fs.existsSync(store.jobsDir)).toBe(false);
    const calls = [...debug.mock.calls, ...info.mock.calls];
    const diagnostic = calls.find(([message]) => String(message).includes('[PluginJobStore]'));
    expect(diagnostic, 'list() must log why it returned an empty list').toBeTruthy();
    expect(String(diagnostic?.[0])).toContain('jobs directory');
    expect(diagnostic?.[1]).toMatchObject({ jobsDir: store.jobsDir });
    // 诊断不能走 stdout（MCP 协议通道）。
    expect(stdout.mock.calls.some(([chunk]) => String(chunk).includes('[PluginJobStore]'))).toBe(
      false
    );
  });
});
