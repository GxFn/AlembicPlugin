import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { attachPlanScopeTargetCounts } from '../../lib/recipe-generation/host-agent-workflows/cold-start.js';
import {
  BRIEFING_INLINE_BUDGET_BYTES,
  attachFullBriefingRef,
  budgetBriefingResponseData,
} from '../../lib/recipe-generation/host-agent-workflows/briefing-budget.js';
import {
  type TransientTransportRef,
  transientTransportPath,
} from '../../lib/shared/transient-transport.js';

// U3：共享预算步骤 budgetBriefingResponseData 单测。stage-无关：≤预算→内联+清理 transient /
// >预算→writeTransientTransport+attachRef meta；compact 回调（cold-start 形态）被调、结果被采用；
// 无 compact（rescan 形态）→只附 transient 引用、不瘦身内联。

const PROJECT_ROOT = '/tmp/u3-briefing-budget-project';

// 内联回填用的 attachRef：与 cold-start/rescan 同口径，把 ref 写进 meta.fullBriefingRef。
const attachRef = (data: Record<string, unknown>, ref: TransientTransportRef | null) =>
  attachFullBriefingRef(data, ref);

describe('budgetBriefingResponseData', () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'u3-briefing-budget-'));
  });

  afterEach(async () => {
    await fs.rm(dataRoot, { force: true, recursive: true });
  });

  function transientPathFor(name: string): string {
    return transientTransportPath({ dataRoot, name, projectRoot: PROJECT_ROOT });
  }

  async function fileExists(p: string): Promise<boolean> {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  test('inlines under budget, sets meta.fullBriefingRef=null, writes no transient', async () => {
    const response: Record<string, unknown> = { data: { hello: 'world', meta: { source: 'x' } } };

    await budgetBriefingResponseData(response, {
      dataRoot,
      projectRoot: PROJECT_ROOT,
      transportName: 'rescan-briefing',
      inlineBudgetBytes: BRIEFING_INLINE_BUDGET_BYTES,
      attachRef,
    });

    const data = response.data as Record<string, unknown>;
    // 内联：既有字段保留 + meta.fullBriefingRef 显式 null（与历史 cold-start 一致）。
    expect(data.hello).toBe('world');
    expect((data.meta as Record<string, unknown>).source).toBe('x');
    expect((data.meta as Record<string, unknown>).fullBriefingRef).toBeNull();
    // 未超预算：不写 transient。
    expect(await fileExists(transientPathFor('rescan-briefing'))).toBe(false);
  });

  test('removes a stale transient when back under budget (idempotent cleanup)', async () => {
    const stale = transientPathFor('rescan-briefing');
    await fs.mkdir(path.dirname(stale), { recursive: true });
    await fs.writeFile(stale, '{"stale":true}\n', 'utf8');
    expect(await fileExists(stale)).toBe(true);

    const response: Record<string, unknown> = { data: { small: 'ok' } };
    await budgetBriefingResponseData(response, {
      dataRoot,
      projectRoot: PROJECT_ROOT,
      transportName: 'rescan-briefing',
      inlineBudgetBytes: BRIEFING_INLINE_BUDGET_BYTES,
      attachRef,
    });

    // ≤预算路径清理遗留 transient。
    expect(await fileExists(stale)).toBe(false);
  });

  test('over budget without compact (rescan shape): writes transient + meta.fullBriefingRef, keeps full inline', async () => {
    // 构造 >预算 payload：单字段大字符串确保超过内联预算。
    const big = 'x'.repeat(BRIEFING_INLINE_BUDGET_BYTES + 4096);
    const response: Record<string, unknown> = { data: { big, meta: { source: 'rescan' } } };

    await budgetBriefingResponseData(response, {
      dataRoot,
      projectRoot: PROJECT_ROOT,
      transportName: 'rescan-briefing',
      inlineBudgetBytes: BRIEFING_INLINE_BUDGET_BYTES,
      attachRef,
    });

    const transientPath = transientPathFor('rescan-briefing');
    expect(await fileExists(transientPath)).toBe(true);

    const data = response.data as Record<string, unknown>;
    const ref = (data.meta as Record<string, unknown>).fullBriefingRef as Record<string, unknown>;
    // 超预算：meta.fullBriefingRef 指向 transient（含 bytes/path），无 compact→内联仍是完整 data。
    expect(ref).not.toBeNull();
    expect(ref.path).toBe(transientPath);
    expect(typeof ref.bytes).toBe('number');
    expect(data.big).toBe(big);
    // transient 落盘的是完整 inline（含 meta.fullBriefingRef=null 占位）。
    const persisted = JSON.parse(await fs.readFile(transientPath, 'utf8')) as Record<string, unknown>;
    expect((persisted as { big?: string }).big).toBe(big);
    expect((persisted.meta as Record<string, unknown>).fullBriefingRef).toBeNull();
  });

  test('over budget with compact (cold-start shape): compact callback receives the real ref and its result is used', async () => {
    const big = 'y'.repeat(BRIEFING_INLINE_BUDGET_BYTES + 4096);
    const response: Record<string, unknown> = { data: { big, meta: {} } };

    let compactRef: TransientTransportRef | null = null;
    let compactInlineBig: unknown;
    await budgetBriefingResponseData(response, {
      dataRoot,
      projectRoot: PROJECT_ROOT,
      transportName: 'bootstrap-briefing',
      inlineBudgetBytes: BRIEFING_INLINE_BUDGET_BYTES,
      attachRef,
      // cold-start 形态：compact 承载瘦身 + attachRef(ref)，返回最终内联（这里用最小桩：丢弃 big、写 ref）。
      compact: (fullInline, ref) => {
        compactRef = ref;
        compactInlineBig = (fullInline as { big?: string }).big;
        return attachFullBriefingRef({ trimmed: true } as Record<string, unknown>, ref);
      },
    });

    const transientPath = transientPathFor('bootstrap-briefing');
    expect(await fileExists(transientPath)).toBe(true);
    // compact 收到真实 ref（指向已落盘 transient）+ 完整 fullInline（含 big）。
    expect(compactRef).not.toBeNull();
    expect((compactRef as TransientTransportRef).path).toBe(transientPath);
    expect(compactInlineBig).toBe(big);
    // 最终内联=compact 的返回（big 已被丢弃、保留 ref）。
    const data = response.data as Record<string, unknown>;
    expect(data.trimmed).toBe(true);
    expect(data.big).toBeUndefined();
    expect((data.meta as Record<string, unknown>).fullBriefingRef).not.toBeNull();
  });

  test('non-record response.data starts from empty object', async () => {
    const response: Record<string, unknown> = { data: null };
    await budgetBriefingResponseData(response, {
      dataRoot,
      projectRoot: PROJECT_ROOT,
      transportName: 'rescan-briefing',
      inlineBudgetBytes: BRIEFING_INLINE_BUDGET_BYTES,
      attachRef,
    });
    const data = response.data as Record<string, unknown>;
    expect((data.meta as Record<string, unknown>).fullBriefingRef).toBeNull();
  });
});

// U3 item4：moduleMining 计数对称背后的 attachPlanScopeTargetCounts 行为——moduleScope 空=no-op
// （deepMining 不调的等价行为）、moduleScope 命中=按 sourceFileFacts 补每模块目标计数。
describe('attachPlanScopeTargetCounts (moduleMining symmetry backing)', () => {
  const sourceFileFacts = [
    { filePath: 'src/auth/login.ts' },
    { filePath: 'src/auth/token.ts' },
    { filePath: 'src/payments/charge.ts' },
  ];

  test('no-op when moduleScope is empty (deepMining path)', () => {
    const briefing = { targets: [{ name: 'existing' }] };
    const out = attachPlanScopeTargetCounts(briefing, { moduleScope: [], sourceFileFacts });
    // 空 moduleScope→原样返回（引用相等，证明未改写）。
    expect(out).toBe(briefing);
  });

  test('patches per-module target counts from sourceFileFacts when moduleScope present', () => {
    const briefing = { targets: [] as Array<Record<string, unknown>> };
    const out = attachPlanScopeTargetCounts(briefing, {
      moduleScope: ['src/auth'],
      sourceFileFacts,
    });
    const target = out.targets.find((t) => (t as { modulePath?: string }).modulePath === 'src/auth');
    expect(target).toBeDefined();
    // src/auth 下两文件 → fileCount=2、source=plan-module-scope。
    expect((target as Record<string, unknown>).fileCount).toBe(2);
    expect((target as Record<string, unknown>).source).toBe('plan-module-scope');
  });
});
