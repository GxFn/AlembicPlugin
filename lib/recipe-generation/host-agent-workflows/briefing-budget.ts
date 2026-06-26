// U3：cold-start 与 rescan/deepMining/moduleMining 共享的「响应 data 预算化」步骤。
// stage-无关：测量 response.data 的 JSON 字节，≤预算→内联回填并清理可能遗留的 transient；
// >预算→把完整 data 写入 transient transport，再经 attachRef 把引用写进 meta；各 stage 专属的瘦身
// 阶梯（如 cold-start 的 compact→trim）作为可选 compact 回调注入，**不下沉**到本共享层。
// 复用 #shared/transient-transport.ts 原语；本模块不持有任何 stage 专属压缩判定。

import {
  jsonByteLength,
  removeTransientTransportIfPresent,
  type TransientTransportRef,
  writeTransientTransport,
} from '#shared/transient-transport.js';

// 共享内联预算默认 18KB（沿用 cold-start 历史 COLD_START_BRIEFING_INLINE_BUDGET_BYTES 口径）。
export const BRIEFING_INLINE_BUDGET_BYTES = 18 * 1024;

/**
 * 把 transient 引用（或内联时的 null）写进 briefing 的 `meta.fullBriefingRef`。
 *
 * cold-start 与 rescan 共用此 attachRef：复用 output allowlist 既有键 `fullBriefingRef`
 * （`core-tools/output.ts` ALLOWED_CLEAN_META_KEYS + `output-contract.ts` schema），
 * 因此扩展到 rescan 时无需改 allowlist。既有 meta 字段全部保留。
 */
export function attachFullBriefingRef<T extends { meta?: Record<string, unknown> }>(
  briefing: T,
  fullBriefingRef: TransientTransportRef | null
): T & { meta: Record<string, unknown> } {
  return {
    ...briefing,
    meta: {
      ...(briefing.meta || {}),
      fullBriefingRef,
    },
  };
}

export interface BudgetBriefingResponseDataOptions {
  // transient 落盘根目录；缺省时 writeTransientTransport/removeTransientTransportIfPresent
  // 经 WorkspaceResolver 从 projectRoot 解析（与 transient-transport 原语口径一致）。
  dataRoot?: string;
  projectRoot: string;
  // transient transport 命名（cold-start='bootstrap-briefing'、rescan='rescan-briefing'）。
  transportName: string;
  inlineBudgetBytes: number;
  // attachRef：内联测量/回填与（无 compact 时）超预算结果都用它把 ref 写进 meta。
  attachRef: (
    data: Record<string, unknown>,
    ref: TransientTransportRef | null
  ) => Record<string, unknown>;
  // compact（可选）：超预算时的 stage 专属变换，入参=已 attachRef(null) 的完整内联 data + 真实 ref，
  // 返回最终内联 data。cold-start 在此承载 compact→attachRef(ref)→trim 的逐级瘦身（trim 逐级测量
  // 含 ref 的体积，故顺序须在回调内自洽）；省略=超预算只写 transient + attachRef(ref)、不瘦身内联。
  compact?: (
    fullInline: Record<string, unknown>,
    ref: TransientTransportRef
  ) => Record<string, unknown>;
}

/**
 * 就地预算化 `response.data`：读取→以 null 占位测量→内联回填或 transient+ref。
 *
 * - `response.data` 非 record 时按空对象起算（与 cold-start 历史行为一致）。
 * - 内联候选先把 ref 占位成 null 一起测量，确保与最终内联形态同字节口径（避免 ref 字段
 *   导致越界误判）；≤预算时幂等清理可能遗留的旧 transient。
 */
export async function budgetBriefingResponseData(
  response: Record<string, unknown>,
  options: BudgetBriefingResponseDataOptions
): Promise<void> {
  const data = readRecord(response.data) ?? {};
  const fullInline = options.attachRef(data, null);
  if (jsonByteLength(fullInline) <= options.inlineBudgetBytes) {
    await removeTransientTransportIfPresent({
      dataRoot: options.dataRoot,
      name: options.transportName,
      projectRoot: options.projectRoot,
    });
    response.data = fullInline;
    return;
  }

  // >预算：完整 data 落 transient transport，再按 stage 是否提供 compact 决定最终内联形态。
  const ref = await writeTransientTransport({
    dataRoot: options.dataRoot,
    name: options.transportName,
    payload: fullInline,
    projectRoot: options.projectRoot,
  });
  response.data = options.compact
    ? options.compact(fullInline, ref)
    : options.attachRef(fullInline, ref);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
