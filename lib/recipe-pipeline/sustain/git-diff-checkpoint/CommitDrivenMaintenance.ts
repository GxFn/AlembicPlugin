import { isAbsolute, relative } from 'node:path';
import {
  describeUnifiedEvolutionRouteIncomplete,
  type HostAgentFileChangeHandler,
  isUnifiedEvolutionReportRouteComplete,
  type UnifiedEvolutionReport,
} from '#recipe-pipeline/sustain/HostAgentFileChangeHandler.js';
import {
  createPluginGitDiffCheckpointRuntime,
  type PluginGitDiffCheckpointContainer,
  type PluginGitDiffCheckpointSurface,
  recordPluginGitDiffCheckpointRouteOutcome,
} from './DurableGitDiffCheckpointRouting.js';
import { GitDiffScanner, type GitDiffScanResult } from './GitDiffScanner.js';

// UM#2：commit-driven 维护的唯一编排。原先两个入口——alembic_rescan 公共 workflow
// （knowledge-rescan.runRescanUnifiedEvolution）与工具尾 surface 注入
// （opportunistic-evolution-presenter.attachPluginOpportunisticEvolutionSurface）——各自重复一份
// 近乎相同的 createPluginGitDiffCheckpointRuntime → scanOnce → handleFileChanges → recordRouteOutcome。
// 这里抽为单一编排，两入口都调；surface 因 serviceGate/toolOutcome 不同各入口自行构建。
// 不改信封语义：runtime/scanOnce/handleFileChanges/recordRouteOutcome 的调用顺序与参数与原两入口一致，
// route-complete 判定与 routeError 兜底也一致；presenter 的 resident 去抖以 residentSearchEnhancementReady
// 参数复刻（rescan 传 false=从不去抖）。rescan 的 prepareRescanState 顺序由其调用点保留（在调用本函数之前），
// 不在本函数内。

export interface CommitDrivenMaintenanceInput {
  // 入口各自的 HostAgentFileChangeHandler 工厂（presenter 与 rescan 经不同容器装配，故由入口提供）。
  buildHandler: (projectRoot: string) => HostAgentFileChangeHandler | null;
  container: PluginGitDiffCheckpointContainer;
  handlerUnavailableReason: string;
  now?: number;
  projectRoot: string;
  // presenter 去抖：resident 检索增强就绪且本次无 HEAD 变化时不路由（无新提交需维护）。rescan 省略=false。
  residentSearchEnhancementReady?: boolean;
  runtimeScope?: {
    currentFolderId?: string | null;
    projectScopeId?: string | null;
    /**
     * 当前 folder 的绝对路径（ProjectScope folderIndex 的注册路径）。
     * 传入时代码漂移扫描以该 folder 自己的 git 仓为对象（Alembic 空间只关注
     * 注册的子仓库；workspace 根是 Wakeflow 协作区 git 仓，不是知识源）——
     * scan 结果的事件路径会回映射为 workspace 相对（refs 表的路径空间）。
     * 省略/非法时退回 projectRoot 扫描（单仓项目模式的既有行为）。
     */
    currentFolderPath?: string | null;
  };
}

export interface CommitDrivenMaintenanceResult {
  checkpoint: PluginGitDiffCheckpointSurface | undefined;
  report: UnifiedEvolutionReport | null;
  routeAttempted: boolean;
  routeError: string | null;
  scan: GitDiffScanResult;
}

// 与原两入口的 shouldRoute* 字节一致：未扫描/无事件/截断、或 HEAD 范围不可用/非祖先无 mergeBase 时不路由。
export function shouldRouteCommitDrivenMaintenance(scan: GitDiffScanResult): boolean {
  if (!scan.scanned || scan.events.length === 0 || scan.truncated) {
    return false;
  }
  if (scan.headChanged && scan.headRangeStatus === 'unavailable') {
    return false;
  }
  if (scan.headChanged && scan.headRangeStatus === 'non-ancestor' && !scan.mergeBase) {
    return false;
  }
  return true;
}

export async function runCommitDrivenMaintenance(
  input: CommitDrivenMaintenanceInput
): Promise<CommitDrivenMaintenanceResult> {
  const scanRoot = resolveMaintenanceScanRoot(input);
  const runtime = createPluginGitDiffCheckpointRuntime(input.container, {
    baselineProjectRoot: scanRoot,
    currentFolderId: input.runtimeScope?.currentFolderId ?? null,
    projectRoot: input.projectRoot,
    projectScopeId: input.runtimeScope?.projectScopeId ?? null,
  });
  const previousHead = runtime?.checkpointCommit ?? null;
  // 空间根修（2026-07-06）：漂移扫描对象 = 当前 folder 自己的 git 仓（Alembic 空间
  // 只关注 ProjectScope 注册的子仓库）。workspace 根是 Wakeflow 协作区仓，其 untracked
  // 台账曾把事件预算挤爆（scale-guard:503>200）。首轮切换时 checkpoint 里残留的
  // workspace 根仓 commit 在 folder 仓中解析不到 merge-base → headRangeStatus
  // unavailable → 本轮不路由、checkpoint 前进为 folder 仓 HEAD——一次性自愈。
  const scanner = new GitDiffScanner({ projectRoot: scanRoot });
  const rawScan = await scanner.scanOnce(input.now ?? Date.now(), { previousHead });
  const scan = remapScanToProjectSpace(rawScan, scanRoot, input.projectRoot);

  let report: UnifiedEvolutionReport | null = null;
  let routeError: string | null = null;
  let routeAttempted = false;

  // resident 检索增强去抖（presenter 专用；rescan 自己拥有路由、从不去抖）。
  const deferToResidentSearch = Boolean(input.residentSearchEnhancementReady) && !scan.headChanged;
  if (!deferToResidentSearch && shouldRouteCommitDrivenMaintenance(scan)) {
    routeAttempted = true;
    const handler = input.buildHandler(input.projectRoot);
    if (handler) {
      try {
        // maint-fix-plugin：把 scanner 已算的 commit-range（mergeBase..HEAD）透传给 handler，供 git-head
        // （committed）事件走 commit-range diff 做影响评估（committed→propose 收口）。range 直接取自
        // scanner 返回的 scan.range，不另查 checkpoint 游标表；工作树无 range 时为 undefined=默认 git diff HEAD。
        const commitRange = scan.range ? `${scan.range.from}..${scan.range.to}` : undefined;
        report = await handler.handleFileChanges(scan.events, commitRange);
        if (!isUnifiedEvolutionReportRouteComplete(report)) {
          routeError = describeUnifiedEvolutionRouteIncomplete(report);
        }
      } catch (error: unknown) {
        routeError = error instanceof Error ? error.message : String(error);
      }
    } else {
      routeError = input.handlerUnavailableReason;
    }
  }

  const checkpoint = runtime
    ? recordPluginGitDiffCheckpointRouteOutcome({
        report,
        routeAttempted,
        routeError,
        runtime,
        scan,
      })
    : undefined;

  return { checkpoint, report, routeAttempted, routeError, scan };
}

/**
 * 解析漂移扫描根：runtimeScope.currentFolderPath 合法（绝对路径、位于 projectRoot
 * 之内且不是 projectRoot 本身）→ 扫 folder 仓；否则退回 projectRoot（单仓模式）。
 * 越界/相对路径一律拒收并退回，防止 scope 数据把扫描带出工作区。
 */
function resolveMaintenanceScanRoot(input: CommitDrivenMaintenanceInput): string {
  const folderPath = input.runtimeScope?.currentFolderPath;
  if (!folderPath || !isAbsolute(folderPath)) {
    return input.projectRoot;
  }
  const rel = relative(input.projectRoot, folderPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return input.projectRoot;
  }
  return folderPath;
}

/**
 * 把 folder 仓扫出的事件路径回映射为 workspace 相对（`<folder>/…`）——
 * recipe_source_refs 与下游影响匹配全部使用该路径空间。scanRoot 即 projectRoot
 * 时原样返回（单仓模式零开销）。
 */
function remapScanToProjectSpace(
  scan: GitDiffScanResult,
  scanRoot: string,
  projectRoot: string
): GitDiffScanResult {
  if (scanRoot === projectRoot) {
    return scan;
  }
  const prefix = relative(projectRoot, scanRoot).replaceAll('\\', '/');
  if (!prefix) {
    return scan;
  }
  return {
    ...scan,
    events: scan.events.map((event) => ({
      ...event,
      path: `${prefix}/${event.path}`,
      ...(event.oldPath ? { oldPath: `${prefix}/${event.oldPath}` } : {}),
    })),
  };
}
