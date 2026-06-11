#!/usr/bin/env node
/**
 * run-shared-asset-drift-gate.mjs — 插件侧共享资产漂移门禁入口（RC5 p2）
 *
 * 门禁脚本本身是方向性的：它把自己所在仓库当作权威（main）侧，所以插件侧
 * 不能直接执行本仓库的 verbatim 副本（scripts/check-shared-asset-drift.mjs
 * 与 config/shared-asset-manifest.json 只作为字节级 self-check 同步副本存在）。
 * 本包装器从插件流水线调用权威检出（../Alembic）的门禁脚本，并把本仓库
 * 作为 sibling 传入，方向因此保持正确；严格模式（不带
 * --allow-pending-sync）—— p2 副本落地后插件侧不允许出现 pending-sync。
 *
 * 跳过语义与权威脚本一致：standalone clone（没有权威检出）打印 SKIP 并以
 * 0 退出，不拦截独立克隆的 check 流水线。
 *
 * 用法: node scripts/run-shared-asset-drift-gate.mjs
 *   权威检出定位：ALEMBIC_MAIN_PATH 环境变量 > 默认 ../Alembic
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainPath = path.resolve(repoRoot, process.env.ALEMBIC_MAIN_PATH ?? '../Alembic');
const gateScript = path.join(mainPath, 'scripts', 'check-shared-asset-drift.mjs');

if (!fs.existsSync(gateScript)) {
  console.log(
    `[shared-asset-drift] SKIP — authority checkout not found at ${mainPath} ` +
      '(set ALEMBIC_MAIN_PATH to point at the Alembic main repo). ' +
      'Standalone clones skip this gate by design.'
  );
  process.exit(0);
}

// 严格模式：不传 --allow-pending-sync；插件副本已同步后任何 pending-sync 都是失败
const result = spawnSync(process.execPath, [gateScript, '--sibling', repoRoot], {
  cwd: mainPath,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
