/**
 * U1 #2 单测：per-模块 PlanSelectionModuleBinding → Core per-cell ModuleCellBinding 拍扁，
 * 以及拍扁结果透传进 Core buildKnowledgeRescanPlan 后产出正确的 per-cell cellPlans。
 *
 * 覆盖：
 *   1. 拍扁正确性：一个 binding（dimensions=[a,b]）→ 恰好 2 条 cell（dimensionId a / b）。
 *   2. 心跳透传：moduleA(dims=[x],target=3) + moduleB(dims=[y],target=2) 经拍扁喂 Core，
 *      cellPlans 得到 cellA(dimensionId=x,perCellTarget=3) / cellB(dimensionId=y,perCellTarget=2)。
 *   3. moduleCount：拍扁本身不依赖 moduleCount；Core 缺省按本批去重模块数。
 */
import {
  buildKnowledgeRescanPlan,
  type RelevanceAuditSummary,
} from '@alembic/core/host-agent-workflows';
import type { DimensionDef } from '@alembic/core/test-fixtures';
import { describe, expect, test } from 'vitest';
import { flattenModuleBindingsToCells } from '#recipe-generation/host-agent-workflows/knowledge-rescan.js';
import type { PlanSelectionModuleBinding } from '#recipe-generation/plan-generation-gate.js';

const dimensions: DimensionDef[] = [
  { id: 'x', label: 'X' },
  { id: 'y', label: 'Y' },
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
];

describe('flattenModuleBindingsToCells (U1 #2)', () => {
  test('per-module binding with dimensions [a,b] → exactly 2 per-cell ModuleCellBinding', () => {
    const bindings: PlanSelectionModuleBinding[] = [
      {
        modulePath: 'src/auth',
        moduleId: 'mod-auth',
        dimensions: ['a', 'b'],
        targetRecipes: 4,
      },
    ];

    const cells = flattenModuleBindingsToCells(bindings);

    expect(cells).toHaveLength(2);
    expect(cells.map((cell) => cell.dimensionId).sort()).toEqual(['a', 'b']);
    // 每条 cell 都带 canonical 化的 moduleName(末段=auth) + moduleId + per-cell target。
    for (const cell of cells) {
      expect(cell.moduleName).toBe('auth');
      expect(cell.moduleId).toBe('mod-auth');
      expect(cell.targetRecipes).toBe(4);
    }
  });

  test('dedupes repeated dimensions and skips blank dimensions', () => {
    const bindings: PlanSelectionModuleBinding[] = [
      { modulePath: 'src/api', dimensions: ['x', 'x', '  ', 'y'] },
    ];

    const cells = flattenModuleBindingsToCells(bindings);

    expect(cells.map((cell) => cell.dimensionId).sort()).toEqual(['x', 'y']);
  });

  test('moduleName falls back to moduleId when modulePath has no usable segment', () => {
    const bindings: PlanSelectionModuleBinding[] = [
      { modulePath: '/', moduleId: 'mod-root', dimensions: ['x'] },
    ];

    const cells = flattenModuleBindingsToCells(bindings);

    expect(cells).toHaveLength(1);
    expect(cells[0]?.moduleName).toBe('mod-root');
    expect(cells[0]?.moduleId).toBe('mod-root');
  });

  test('binding without targetRecipes omits per-cell targetRecipes (Core tier default applies)', () => {
    const bindings: PlanSelectionModuleBinding[] = [{ modulePath: 'src/api', dimensions: ['x'] }];

    const cells = flattenModuleBindingsToCells(bindings);

    expect(cells).toHaveLength(1);
    expect(cells[0]?.targetRecipes).toBeUndefined();
  });
});

describe('heart passthrough: flatten → Core buildKnowledgeRescanPlan cellPlans (U1 #2)', () => {
  test('moduleA(dims=[x],target=3) + moduleB(dims=[y],target=2) → per-cell cellPlans', () => {
    const bindings: PlanSelectionModuleBinding[] = [
      { modulePath: 'src/moduleA', moduleId: 'mod-a', dimensions: ['x'], targetRecipes: 3 },
      { modulePath: 'src/moduleB', moduleId: 'mod-b', dimensions: ['y'], targetRecipes: 2 },
    ];

    const cells = flattenModuleBindingsToCells(bindings);
    expect(cells).toHaveLength(2);

    // 透传进 Core：buildKnowledgeRescanPlan 接到 moduleBindings 后产出 per-cell cellPlans。
    const plan = buildKnowledgeRescanPlan({
      recipeEntries: [],
      auditSummary: emptyAuditSummary(),
      dimensions,
      requestedDimensionIds: ['x', 'y'],
      moduleBindings: cells,
      // moduleCount 缺省 → Core 用本批去重模块数（2）。
    });

    expect(plan.cellPlans).toBeDefined();
    const cellPlans = plan.cellPlans ?? [];
    expect(cellPlans).toHaveLength(2);

    const cellX = cellPlans.find((cell) => cell.dimensionId === 'x');
    const cellY = cellPlans.find((cell) => cell.dimensionId === 'y');
    expect(cellX?.perCellTarget).toBe(3);
    expect(cellX?.moduleName).toBe('moduleA');
    expect(cellX?.gap).toBe(3); // perCellCoverage 缺省 0 → gap = target
    expect(cellY?.perCellTarget).toBe(2);
    expect(cellY?.moduleName).toBe('moduleB');
    expect(cellY?.gap).toBe(2);
  });

  test('without moduleBindings, Core cellPlans is undefined (zero-regression fallback)', () => {
    const plan = buildKnowledgeRescanPlan({
      recipeEntries: [],
      auditSummary: emptyAuditSummary(),
      dimensions,
      requestedDimensionIds: ['x'],
    });

    expect(plan.cellPlans).toBeUndefined();
  });
});

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
