/**
 * U2 覆盖账本接线单测（不依赖完整容器的纯函数 + 假仓 + Core 契约重验）。
 *
 * 覆盖点：
 *   1. writeCoverageLedgerForCompletion：假仓捕获 upsertCell；断言已扫 cell（grade/coveredCount）、
 *      deferred 空行（grade=empty,deferred=1）、exhaustedDeclarations → exhausted+agent-declared。
 *   2. buildCoverageSeedFromCells（plan-tool 导出的纯 helper）：mix empty/thin/partial/covered + valueScore →
 *      只回 empty/thin、价值降序、D2 上限截断（L tier >80 cell 截到 80），排除 exhausted-with-reason。
 *   3. derivePerCellTargetsFromGate（knowledge-rescan 导出）+ Core gap：每维取 MAX；perDimensionTargets={x:8}
 *      透传 Core buildKnowledgeRescanPlan 后 gap 反映 8 而非默认。
 *   4. adviseCoverageLedger（Core）三类停止 + continue：断言 stopReason / suggestion 仅 continue 非空 /
 *      shouldStop；并断言结果结构无任何 blocking 键（advisory 非阻断契约）。
 *
 * 注：U2a/U2c/U2d 的「容器内副作用接线」（dimension-completion / confirmPlan / buildRescanResponse）需要完整
 * ServiceContainer + moduleService + DB，属集成范围；此处只测可独立验证的纯函数与 Core 契约，避免脆弱的容器搭建。
 */

import {
  adviseCoverageLedger,
  buildKnowledgeRescanPlan,
  type RelevanceAuditSummary,
} from '@alembic/core/host-agent-workflows';
import type {
  CoverageLedgerRecord,
  DeepMiningRoundRecord,
  UpsertCoverageLedgerInput,
} from '@alembic/core/repositories';
import type { DimensionDef } from '@alembic/core/test-fixtures';
import { describe, expect, test } from 'vitest';
import {
  type CoverageLedgerWriteInput,
  reflowDeepMiningRoundOnCompletion,
  writeCoverageLedgerForCompletion,
} from '#recipe-generation/host-agent-workflows/coverage-ledger-write.js';
import { derivePerCellTargetsFromGate } from '#recipe-generation/host-agent-workflows/knowledge-rescan.js';
import type { PlanSelectionModuleBinding } from '#recipe-generation/plan-generation-gate.js';
import { buildCoverageSeedFromCells } from '#recipe-generation/plan-tool.js';

// ---- 假仓：只捕获 upsertCell 调用，其它方法最小实现 ----
// CoverageLedgerWriteInput.repository 是 EvolutionCoverageLedgerRepository（含私有字段），结构无法直接构造，
// 故用 unknown 中转为最小测试替身（仅断言 writeCoverageLedgerForCompletion 真正调用的方法）。
function createFakeRepository(): {
  repository: CoverageLedgerWriteInput['repository'];
  upserts: UpsertCoverageLedgerInput[];
} {
  const upserts: UpsertCoverageLedgerInput[] = [];
  const fake = {
    upsertCell(input: UpsertCoverageLedgerInput): CoverageLedgerRecord {
      upserts.push(input);
      // 返回一个最小 record（写入路径不读返回值，字段够编译即可）。
      return {
        projectRoot: input.projectRoot,
        moduleId: input.moduleId,
        dimensionId: input.dimensionId,
        coveredCount: input.coveredCount ?? 0,
        totalCandidateCount: input.totalCandidateCount ?? 0,
        grade: input.grade ?? 'empty',
        exhausted: input.exhausted ?? false,
        exhaustedReason: input.exhaustedReason ?? null,
        exhaustedSource: input.exhaustedSource ?? null,
        coveredSourceRefs: input.coveredSourceRefs ?? [],
        uncoveredHints: input.uncoveredHints ?? [],
        valueScore: input.valueScore ?? null,
        lastRound: input.lastRound ?? null,
        deferred: input.deferred ?? false,
        createdAt: 0,
        updatedAt: 0,
      };
    },
    listRoundsByProjectRoot(): DeepMiningRoundRecord[] {
      return [];
    },
    // biome-ignore lint/suspicious/noExplicitAny: 测试替身仅实现被调用方法，未用方法以 any 占位避免实现整套私有仓。
  } as any;
  return { repository: fake as CoverageLedgerWriteInput['repository'], upserts };
}

describe('writeCoverageLedgerForCompletion (U2 shared helper)', () => {
  test('writes covered cell + uncovered (thin) cell from candidates/coveredPaths', () => {
    const { repository, upserts } = createFakeRepository();

    // Core pathsOverlap 是 segment-safe 目录/文件重叠匹配。
    // 这里 ownedPaths 直接用候选文件全路径（=U2a 把 referencedFiles 与 ownedPath 一起喂候选的等价最小形）：
    //   auth：候选=已覆盖路径 → covered；bill：候选=未覆盖路径 → uncovered（thin）。
    const result = writeCoverageLedgerForCompletion({
      repository,
      projectRoot: '/proj',
      modules: [
        { moduleId: 'auth', moduleName: 'auth', ownedPaths: ['src/auth/login.ts'] },
        { moduleId: 'bill', moduleName: 'bill', ownedPaths: ['src/bill/charge.ts'] },
      ],
      dimensionIds: ['api'],
      candidates: [
        { dimensionIds: ['api'], sourceRefPaths: ['src/auth/login.ts'], importance: 60 },
        { dimensionIds: ['api'], sourceRefPaths: ['src/bill/charge.ts'], importance: 50 },
      ],
      coveredPaths: ['src/auth/login.ts'],
      perCellTarget: 3,
      lastRound: 2,
    });

    // 每个 (module×dimension) 各产一条 upsert（2 模块 × 1 维 = 2 实测 cell）。
    expect(result.writtenCells).toBe(2);
    expect(result.deferredCells).toBe(0);
    expect(upserts).toHaveLength(2);

    const authCell = upserts.find((u) => u.moduleId === 'auth');
    const billCell = upserts.find((u) => u.moduleId === 'bill');
    // auth 候选被覆盖 → coveredCount>0、grade=partial（<perCellTarget 3）；lastRound 戳上；deferred=false。
    expect(authCell?.coveredCount ?? 0).toBeGreaterThan(0);
    expect(authCell?.grade).toBe('partial');
    expect(authCell?.lastRound).toBe(2);
    expect(authCell?.deferred).toBe(false);
    // bill 候选未覆盖 → coveredCount=0 但 totalCandidate>0 → grade=thin（正是 deepMining 想要的空白/单薄信号）。
    expect(billCell?.coveredCount ?? 0).toBe(0);
    expect(billCell?.grade).toBe('thin');
    expect(billCell?.deferred).toBe(false);
  });

  test('directory fallback owns child files without matching pseudo-prefix siblings', () => {
    const { repository, upserts } = createFakeRepository();

    writeCoverageLedgerForCompletion({
      repository,
      projectRoot: '/proj',
      modules: [
        { moduleId: 'auth', moduleName: 'auth', ownedPaths: ['src/auth'] },
        {
          moduleId: 'authentication',
          moduleName: 'authentication',
          ownedPaths: ['src/authentication'],
        },
      ],
      dimensionIds: ['security-auth'],
      candidates: [
        {
          dimensionIds: ['security-auth'],
          sourceRefPaths: ['src/auth/login.ts'],
          importance: 60,
        },
        {
          dimensionIds: ['security-auth'],
          sourceRefPaths: ['src/authentication/session.ts'],
          importance: 60,
        },
      ],
      coveredPaths: ['src/auth/login.ts'],
      perCellTarget: 3,
    });

    const authCell = upserts.find((u) => u.moduleId === 'auth');
    const authenticationCell = upserts.find((u) => u.moduleId === 'authentication');
    expect(authCell?.totalCandidateCount).toBe(1);
    expect(authCell?.coveredCount).toBe(1);
    expect(authCell?.coveredSourceRefs).toEqual(['src/auth/login.ts']);
    expect(authenticationCell?.totalCandidateCount).toBe(1);
    expect(authenticationCell?.coveredCount).toBe(0);
    expect(authenticationCell?.uncoveredHints).toEqual(['src/authentication/session.ts']);
  });

  test('writes deferred blank rows (grade=empty, deferred=1) for cells not built', () => {
    const { repository, upserts } = createFakeRepository();

    const result = writeCoverageLedgerForCompletion({
      repository,
      projectRoot: '/proj',
      modules: [{ moduleId: 'auth', moduleName: 'auth', ownedPaths: ['src/auth'] }],
      dimensionIds: ['api'],
      candidates: [{ dimensionIds: ['api'], sourceRefPaths: ['src/auth'], importance: 50 }],
      coveredPaths: [],
      perCellTarget: 3,
      lastRound: 0,
      // bill×api 未被构建 → 应写 deferred 空行；auth×api 已构建 → deferred 去重不重复写。
      deferredCells: [
        { moduleId: 'bill', dimensionId: 'api' },
        { moduleId: 'auth', dimensionId: 'api' },
      ],
    });

    expect(result.deferredCells).toBe(1);
    const deferredRow = upserts.find((u) => u.moduleId === 'bill' && u.deferred === true);
    expect(deferredRow).toBeDefined();
    expect(deferredRow?.grade).toBe('empty');
    expect(deferredRow?.deferred).toBe(true);
    expect(deferredRow?.coveredCount).toBe(0);
    expect(deferredRow?.lastRound).toBe(0);
    // auth×api 已是实测 cell，绝不被 deferred 空行覆盖。
    const authDeferred = upserts.find((u) => u.moduleId === 'auth' && u.deferred === true);
    expect(authDeferred).toBeUndefined();
  });

  test('exhaustedDeclarations → cell marked exhausted + agent-declared', () => {
    const { repository, upserts } = createFakeRepository();

    writeCoverageLedgerForCompletion({
      repository,
      projectRoot: '/proj',
      modules: [{ moduleId: 'auth', moduleName: 'auth', ownedPaths: ['src/auth'] }],
      dimensionIds: ['api'],
      candidates: [{ dimensionIds: ['api'], sourceRefPaths: ['src/auth'], importance: 50 }],
      coveredPaths: [],
      perCellTarget: 3,
      exhaustedDeclarations: [
        { moduleId: 'auth', dimensionId: 'api', reason: 'no more api recipes worth mining' },
      ],
    });

    const authCell = upserts.find((u) => u.moduleId === 'auth');
    expect(authCell?.exhausted).toBe(true);
    expect(authCell?.exhaustedSource).toBe('agent-declared');
    expect(authCell?.exhaustedReason).toBe('no more api recipes worth mining');
  });

  test('write failure is swallowed (advisory, never throws) and returns zero counts', () => {
    // upsertCell 抛错 → 整体吞掉、返回零计数（绝不阻断维度完成）。
    const throwingRepo = {
      upsertCell() {
        throw new Error('db down');
      },
      listRoundsByProjectRoot() {
        return [];
      },
      // biome-ignore lint/suspicious/noExplicitAny: 同上，测试替身只需被调用方法。
    } as any;

    const result = writeCoverageLedgerForCompletion({
      repository: throwingRepo as CoverageLedgerWriteInput['repository'],
      projectRoot: '/proj',
      modules: [{ moduleId: 'auth', ownedPaths: ['src/auth'] }],
      dimensionIds: ['api'],
      candidates: [{ dimensionIds: ['api'], sourceRefPaths: ['src/auth'] }],
      coveredPaths: [],
      perCellTarget: 3,
    });

    expect(result.writtenCells).toBe(0);
    expect(result.deferredCells).toBe(0);
    expect(result.cells).toEqual([]);
  });
});

// ---- 假仓（带轮次）：捕获 upsertRound + 用 seed 轮次回放 listRoundsByProjectRoot（测 U2d Part B 回流累加）。----
function createFakeRoundRepository(seedRounds: DeepMiningRoundRecord[]): {
  repository: CoverageLedgerWriteInput['repository'];
  rounds: DeepMiningRoundRecord[];
  roundUpserts: Array<{
    roundIndex: number;
    newRecipesThisRound?: number | null;
    completedAt?: number | null;
    startedAt?: number | null;
    triggerActor?: string | null;
  }>;
} {
  // 内部轮次状态：upsertRound 复刻 Core 的 `?? existing` 合并语义（startedAt/triggerActor 缺省保留），
  // 让「累加跨多次完成」可在假仓里如实回放。
  const rounds = [...seedRounds];
  const roundUpserts: Array<{
    roundIndex: number;
    newRecipesThisRound?: number | null;
    completedAt?: number | null;
    startedAt?: number | null;
    triggerActor?: string | null;
  }> = [];
  const fake = {
    listRoundsByProjectRoot(): DeepMiningRoundRecord[] {
      return [...rounds].sort((a, b) => a.roundIndex - b.roundIndex);
    },
    upsertRound(input: {
      projectRoot: string;
      roundIndex: number;
      newRecipesThisRound?: number | null;
      completedAt?: number | null;
      startedAt?: number | null;
      triggerActor?: string | null;
    }): DeepMiningRoundRecord {
      roundUpserts.push({
        roundIndex: input.roundIndex,
        newRecipesThisRound: input.newRecipesThisRound,
        completedAt: input.completedAt,
        startedAt: input.startedAt,
        triggerActor: input.triggerActor,
      });
      const existing = rounds.find((r) => r.roundIndex === input.roundIndex) ?? null;
      const merged: DeepMiningRoundRecord = {
        projectRoot: input.projectRoot,
        roundIndex: input.roundIndex,
        // 复刻 Core upsertRound 合并：缺省字段保留 existing（startedAt/triggerActor）。
        startedAt: input.startedAt ?? existing?.startedAt ?? null,
        completedAt: input.completedAt ?? existing?.completedAt ?? null,
        newRecipesThisRound: input.newRecipesThisRound ?? existing?.newRecipesThisRound ?? 0,
        triggerActor: input.triggerActor ?? existing?.triggerActor ?? null,
        createdAt: existing?.createdAt ?? 0,
        updatedAt: 0,
      };
      const idx = rounds.findIndex((r) => r.roundIndex === input.roundIndex);
      if (idx >= 0) {
        rounds[idx] = merged;
      } else {
        rounds.push(merged);
      }
      return merged;
    },
    // biome-ignore lint/suspicious/noExplicitAny: 测试替身仅实现被调用方法，未用方法以 any 占位。
  } as any;
  return { repository: fake as CoverageLedgerWriteInput['repository'], rounds, roundUpserts };
}

describe('reflowDeepMiningRoundOnCompletion (U2d Part B — round marginal output reflow)', () => {
  test('accumulates new_recipes_this_round across multiple completions + sets completedAt', () => {
    // 已开轮（roundIndex 1，new_recipes 初始 0、startedAt/triggerActor 已写）。
    const { repository, roundUpserts } = createFakeRoundRepository([
      {
        projectRoot: '/proj',
        roundIndex: 1,
        startedAt: 100,
        completedAt: null,
        newRecipesThisRound: 0,
        triggerActor: 'host-agent-rescan',
        createdAt: 0,
        updatedAt: 0,
      },
    ]);

    // 维度 A 完成新增 2 条 → 累计 2。
    const first = reflowDeepMiningRoundOnCompletion({
      repository,
      projectRoot: '/proj',
      newRecipeCount: 2,
      now: 200,
    });
    expect(first.updated).toBe(true);
    expect(first.roundIndex).toBe(1);
    expect(first.newRecipesThisRound).toBe(2);

    // 维度 B 完成新增 1 条 → 累计 3（同一轮跨维度累加）。
    const second = reflowDeepMiningRoundOnCompletion({
      repository,
      projectRoot: '/proj',
      newRecipeCount: 1,
      now: 300,
    });
    expect(second.updated).toBe(true);
    expect(second.newRecipesThisRound).toBe(3);

    // 两次 upsertRound：第二次 newRecipes=3、completedAt=300（轮末=最后一次完成）；startedAt/triggerActor 未被传入（由合并保留）。
    expect(roundUpserts).toHaveLength(2);
    expect(roundUpserts[1]?.newRecipesThisRound).toBe(3);
    expect(roundUpserts[1]?.completedAt).toBe(300);
    expect(roundUpserts[1]?.startedAt).toBeUndefined();
    expect(roundUpserts[1]?.triggerActor).toBeUndefined();
  });

  test('no open round (coldStart completion) → updated:false, writes nothing', () => {
    // 账本无任何轮（coldStart 维度完成时 deepMining 轮尚未开）→ 不造轮。
    const { repository, roundUpserts } = createFakeRoundRepository([]);
    const result = reflowDeepMiningRoundOnCompletion({
      repository,
      projectRoot: '/proj',
      newRecipeCount: 5,
    });
    expect(result.updated).toBe(false);
    expect(result.roundIndex).toBeNull();
    expect(roundUpserts).toHaveLength(0);
  });
});

// ---- 构造账本 record 的测试小工具 ----
function record(
  partial: Partial<CoverageLedgerRecord> &
    Pick<CoverageLedgerRecord, 'moduleId' | 'dimensionId' | 'grade'>
): CoverageLedgerRecord {
  return {
    projectRoot: '/proj',
    coveredCount: 0,
    totalCandidateCount: 0,
    exhausted: false,
    exhaustedReason: null,
    exhaustedSource: null,
    coveredSourceRefs: [],
    uncoveredHints: [],
    valueScore: 0,
    lastRound: null,
    deferred: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe('buildCoverageSeedFromCells (U2b deepMining draft seed)', () => {
  test('returns only empty/thin gap candidates, value-ranked desc, excludes exhausted-with-reason', () => {
    const cells: CoverageLedgerRecord[] = [
      record({
        moduleId: 'm1',
        dimensionId: 'api',
        grade: 'empty',
        valueScore: 90,
        coveredCount: 0,
      }),
      record({
        moduleId: 'm2',
        dimensionId: 'api',
        grade: 'thin',
        valueScore: 70,
        coveredCount: 1,
      }),
      // partial / covered 不进 gap。
      record({
        moduleId: 'm3',
        dimensionId: 'ui',
        grade: 'partial',
        valueScore: 99,
        coveredCount: 2,
      }),
      record({
        moduleId: 'm4',
        dimensionId: 'ui',
        grade: 'covered',
        valueScore: 99,
        coveredCount: 5,
      }),
      // exhausted+reason 的空白格被排除（已尽，非缺口）。
      record({
        moduleId: 'm5',
        dimensionId: 'api',
        grade: 'empty',
        valueScore: 100,
        exhausted: true,
        exhaustedReason: 'done',
      }),
    ];

    const seed = buildCoverageSeedFromCells(cells, { moduleCount: 3 });

    // 仅 m1(empty,90) + m2(thin,70)，价值降序。
    expect(seed.gapCandidates.map((c) => c.moduleId)).toEqual(['m1', 'm2']);
    expect(seed.gapCandidates[0]?.valueScore).toBe(90);
    expect(seed.gapCandidates[1]?.valueScore).toBe(70);
    // existingCount 每维求和：api=0+1+0(m5)=1；ui=2+5=7。
    expect(seed.existingCountByDimension.api).toBe(1);
    expect(seed.existingCountByDimension.ui).toBe(7);
    // rating 分布：api 有 empty(m1)+thin(m2)+empty(m5)=2 empty,1 thin。
    expect(seed.ratingByDimension.api).toMatchObject({ empty: 2, thin: 1 });
    expect(seed.ratingByDimension.ui).toMatchObject({ partial: 1, covered: 1 });
    // suggestedDeficit = max(0, perCellTarget − coveredCount)；m2 coveredCount=1。
    const m2 = seed.gapCandidates.find((c) => c.moduleId === 'm2');
    expect(m2?.suggestedDeficit).toBeGreaterThanOrEqual(0);
  });

  test('applies D2 per-round cell budget cap (L tier = 80)', () => {
    // 构造 200 个空白 cell；moduleCount 大 → L tier → 单轮上限 80。
    const cells: CoverageLedgerRecord[] = [];
    for (let i = 0; i < 200; i += 1) {
      cells.push(record({ moduleId: `m${i}`, dimensionId: 'api', grade: 'empty', valueScore: i }));
    }

    // moduleCount=100 → resolveModuleTier 应判 L（大项目）。
    const seed = buildCoverageSeedFromCells(cells, { moduleCount: 100 });

    expect(seed.tier).toBe('L');
    expect(seed.perRoundCellBudget).toBe(80);
    // 截断到 80 条，且是价值最高的 80（valueScore 199..120 降序）。
    expect(seed.gapCandidates).toHaveLength(80);
    expect(seed.gapCandidates[0]?.valueScore).toBe(199);
    expect(seed.gapCandidates[79]?.valueScore).toBe(120);
  });
});

const gateDimensions: DimensionDef[] = [
  { id: 'x', label: 'X' },
  { id: 'y', label: 'Y' },
];

describe('derivePerCellTargetsFromGate (U2b chain) + Core gap', () => {
  test('per-dimension target takes MAX across bindings; module targets typed', () => {
    const bindings: PlanSelectionModuleBinding[] = [
      { modulePath: 'src/a', moduleId: 'mod-a', dimensions: ['x'], targetRecipes: 5 },
      { modulePath: 'src/b', moduleId: 'mod-b', dimensions: ['x', 'y'], targetRecipes: 8 },
      // 无 targetRecipes 的 binding 不进 perDimensionTargets。
      { modulePath: 'src/c', dimensions: ['y'] },
    ];

    const { perDimensionTargets, moduleDimensionTargets } = derivePerCellTargetsFromGate(bindings);

    // x: max(5,8)=8；y: 只有 b 带数值 8。
    expect(perDimensionTargets).toEqual({ x: 8, y: 8 });
    // moduleDimensionTargets：仅带数值 targetRecipes 的 cell（a:x=5, b:x=8, b:y=8）= 3 条；c 无 target 被过滤。
    expect(moduleDimensionTargets).toHaveLength(3);
    for (const target of moduleDimensionTargets) {
      expect(typeof target.targetRecipes).toBe('number');
      expect(target.dimensionId.length).toBeGreaterThan(0);
    }
  });

  test('perDimensionTargets={x:8} drives Core gap to 8 (not the hard-coded default 5)', () => {
    // 镜像 Core 的 gap 形态：existingCount=0、perDimensionTargets[x]=8 → gap=8。
    const plan = buildKnowledgeRescanPlan({
      recipeEntries: [],
      auditSummary: emptyAuditSummary(),
      dimensions: gateDimensions,
      requestedDimensionIds: ['x'],
      perDimensionTargets: { x: 8 },
    });

    const xDecision = plan.executionDecisions.find((d) => d.dimensionId === 'x');
    // gap 用 Agent 目标 8，而非默认 5。
    expect(xDecision?.gap).toBe(8);
    expect(xDecision?.createBudget).toBe(8);
    expect(xDecision?.mode).toBe('produce');
  });

  test('empty bindings → empty derivation (zero-regression)', () => {
    const { perDimensionTargets, moduleDimensionTargets } = derivePerCellTargetsFromGate([]);
    expect(perDimensionTargets).toEqual({});
    expect(moduleDimensionTargets).toEqual([]);
  });
});

describe('adviseCoverageLedger advisory (U2d) — 3 stops + continue, non-blocking', () => {
  test('converged: no blank/thin cells → shouldStop, stopReason=converged, no suggestion', () => {
    const cells: CoverageLedgerRecord[] = [
      record({
        moduleId: 'm1',
        dimensionId: 'api',
        grade: 'covered',
        coveredCount: 5,
        valueScore: 1,
      }),
    ];
    const advisory = adviseCoverageLedger({ cells, latestRound: null, moduleCount: 1 });
    expect(advisory.shouldStop).toBe(true);
    expect(advisory.stopReason).toBe('converged');
    expect(advisory.suggestion).toBeNull();
    // advisory 契约：结果无任何阻断/门禁键。
    assertNoBlockingKey(advisory);
  });

  test('FIRST deepMining round (no prior completed round) does NOT misfire diminishing-returns', () => {
    // Part A 回归守卫：U2d 把开轮挪到 attachCoverageAdvisory 之后，故首轮时 advisory 读到的「上一轮」为空
    //（latestRound=null）——绝不能因「刚开轮 new_recipes=0 < K」误判收益递减、令多轮循环首轮即停。
    // 有空白缺口 + 无已完成轮 → 必须 continue。
    const cells: CoverageLedgerRecord[] = [
      record({ moduleId: 'm1', dimensionId: 'api', grade: 'empty', valueScore: 90 }),
    ];
    const advisory = adviseCoverageLedger({
      cells,
      latestRound: null,
      moduleCount: 1,
      planK: 5,
      planMaxRounds: 10,
    });
    expect(advisory.shouldStop).toBe(false);
    expect(advisory.stopReason).toBe('continue');
    expect(advisory.suggestion).not.toBeNull();
    assertNoBlockingKey(advisory);
  });

  test('diminishing-returns: prior COMPLETED round new recipes < K → shouldStop=diminishing-returns', () => {
    const cells: CoverageLedgerRecord[] = [
      record({ moduleId: 'm1', dimensionId: 'api', grade: 'empty', valueScore: 90 }),
    ];
    // 上一已完成轮（roundIndex 2，completedAt 已写、new_recipes=1 < K=5）→ 收益递减。
    // 这正是 Part A 修复后 advisory 应读的对象：已完成轮的真实边际产出，而非刚开的在产轮。
    const latestRound: DeepMiningRoundRecord = {
      projectRoot: '/proj',
      roundIndex: 2,
      startedAt: 1,
      completedAt: 2,
      newRecipesThisRound: 1, // < K=5 → 收益递减
      triggerActor: 'host-agent-rescan',
      createdAt: 0,
      updatedAt: 0,
    };
    const advisory = adviseCoverageLedger({
      cells,
      latestRound,
      moduleCount: 1,
      planK: 5,
      planMaxRounds: 10,
    });
    expect(advisory.shouldStop).toBe(true);
    expect(advisory.stopReason).toBe('diminishing-returns');
    assertNoBlockingKey(advisory);
  });

  test('round-cap: roundIndex >= maxRounds → shouldStop=round-cap', () => {
    const cells: CoverageLedgerRecord[] = [
      record({ moduleId: 'm1', dimensionId: 'api', grade: 'empty', valueScore: 90 }),
    ];
    // planMaxRounds=1，latestRound.roundIndex=1 → 触发轮次上限（用 high newRecipes 避开收益递减分支）。
    const latestRound: DeepMiningRoundRecord = {
      projectRoot: '/proj',
      roundIndex: 1,
      startedAt: 1,
      completedAt: 2,
      newRecipesThisRound: 999,
      triggerActor: 'host-agent-rescan',
      createdAt: 0,
      updatedAt: 0,
    };
    const advisory = adviseCoverageLedger({
      cells,
      latestRound,
      moduleCount: 1,
      planMaxRounds: 1,
      planK: 1,
    });
    expect(advisory.shouldStop).toBe(true);
    expect(advisory.stopReason).toBe('round-cap');
    assertNoBlockingKey(advisory);
  });

  test('continue: has gaps + low round → suggestion present, shouldStop=false', () => {
    const cells: CoverageLedgerRecord[] = [
      record({ moduleId: 'm1', dimensionId: 'api', grade: 'empty', valueScore: 90 }),
      record({ moduleId: 'm2', dimensionId: 'ui', grade: 'thin', valueScore: 80, coveredCount: 1 }),
    ];
    // 首轮（roundIndex 0）、高边际 → continue；planMaxRounds 给大避免轮次上限。
    const latestRound: DeepMiningRoundRecord = {
      projectRoot: '/proj',
      roundIndex: 0,
      startedAt: 1,
      completedAt: 2,
      newRecipesThisRound: 999,
      triggerActor: 'host-agent-rescan',
      createdAt: 0,
      updatedAt: 0,
    };
    const advisory = adviseCoverageLedger({
      cells,
      latestRound,
      moduleCount: 1,
      planK: 1,
      planMaxRounds: 10,
    });
    expect(advisory.shouldStop).toBe(false);
    expect(advisory.stopReason).toBe('continue');
    expect(advisory.suggestion).not.toBeNull();
    expect(advisory.valueSortedGaps.length).toBeGreaterThan(0);
    assertNoBlockingKey(advisory);
  });
});

// advisory 非阻断契约断言：结果不得含任何 blocking/gate/autoTrigger 键。
function assertNoBlockingKey(advisory: Record<string, unknown>): void {
  for (const key of Object.keys(advisory)) {
    expect(key).not.toMatch(/block|gate|autoTrigger|shouldBlock/i);
  }
}

// 最小空 audit summary（buildKnowledgeRescanPlan 必填）。
function emptyAuditSummary(): RelevanceAuditSummary {
  return {
    totalAudited: 0,
    healthy: 0,
    watch: 0,
    decay: 0,
    severe: 0,
    dead: 0,
    proposalsCreated: 0,
    immediateDeprecated: 0,
    results: [],
  };
}
