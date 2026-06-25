import {
  describeUnifiedEvolutionRouteIncomplete,
  type FileChangeHandler,
  isUnifiedEvolutionReportRouteComplete,
  type UnifiedEvolutionReport,
} from '#recipe-generation/evolution/FileChangeHandler.js';
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
  // 入口各自的 FileChangeHandler 工厂（presenter 与 rescan 经不同容器装配，故由入口提供）。
  buildHandler: (projectRoot: string) => FileChangeHandler | null;
  container: PluginGitDiffCheckpointContainer;
  handlerUnavailableReason: string;
  now?: number;
  projectRoot: string;
  // presenter 去抖：resident 检索增强就绪且本次无 HEAD 变化时不路由（无新提交需维护）。rescan 省略=false。
  residentSearchEnhancementReady?: boolean;
  runtimeScope?: { currentFolderId?: string | null; projectScopeId?: string | null };
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
  const runtime = createPluginGitDiffCheckpointRuntime(input.container, {
    currentFolderId: input.runtimeScope?.currentFolderId ?? null,
    projectRoot: input.projectRoot,
    projectScopeId: input.runtimeScope?.projectScopeId ?? null,
  });
  const previousHead = runtime?.checkpointCommit ?? null;
  const scanner = new GitDiffScanner({ projectRoot: input.projectRoot });
  const scan = await scanner.scanOnce(input.now ?? Date.now(), { previousHead });

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
        report = await handler.handleFileChanges(scan.events);
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
