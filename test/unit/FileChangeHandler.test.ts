import type { FileChangeEvent } from '@alembic/core/types';
import { vi } from 'vitest';
import { FileChangeHandler } from '../../lib/recipe-generation/evolution/FileChangeHandler.js';

/* ════════════════════════════════════════════
 *  Mock ContentImpactAnalyzer — 控制 diff 返回
 * ════════════════════════════════════════════ */

const mockAssessFileImpact = vi.fn();
const mockExtractRecipeTokens = vi.fn(() => ({ tokens: new Set(), sources: new Map() }));

vi.mock('@alembic/core/evolution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@alembic/core/evolution')>()),
  assessFileImpact: (...args: unknown[]) => mockAssessFileImpact(...args),
  extractRecipeTokens: (...args: unknown[]) => mockExtractRecipeTokens(...args),
}));

/* ════════════════════════════════════════════
 *  Mock 工厂
 * ════════════════════════════════════════════ */

function mockSourceRefRepo() {
  const _refs: Array<{ recipeId: string; sourcePath: string; status: string }> = [];
  return {
    findBySourcePath: vi.fn((path: string) =>
      _refs.filter((r) => r.sourcePath === path && r.status === 'active')
    ),
    findByRecipeId: vi.fn((id: string) => _refs.filter((r) => r.recipeId === id)),
    findAll: vi.fn(() => _refs),
    upsert: vi.fn(),
    replaceSourcePath: vi.fn(),
    _seed(recipeId: string, sourcePath: string, status = 'active') {
      _refs.push({ recipeId, sourcePath, status });
    },
  };
}

function mockKnowledgeRepo() {
  const _store = new Map<string, Record<string, unknown>>();
  return {
    findById: vi.fn(async (id: string) => _store.get(id) ?? null),
    findSourceFileAndReasoning: vi.fn(async (id: string) => {
      const e = _store.get(id);
      return e ? { reasoning: JSON.stringify(e.reasoning ?? {}) } : null;
    }),
    updateReasoning: vi.fn(),
    _seed(id: string, data: Record<string, unknown>) {
      _store.set(id, { id, lifecycle: 'active', ...data });
    },
  };
}

function mockContentPatcher() {
  return {
    applyProposal: vi.fn(async () => ({ success: true })),
  };
}

function mockSignalBus() {
  const _signals: Array<{
    type: string;
    source: string;
    weight: number;
    opts: Record<string, unknown>;
  }> = [];
  return {
    send: vi.fn((type: string, source: string, weight: number, opts: Record<string, unknown>) => {
      _signals.push({ type, source, weight, opts });
    }),
    _signals,
  };
}

function mockGateway() {
  return {
    submit: vi.fn(async () => ({
      recipeId: '',
      action: 'deprecate',
      outcome: 'immediately-executed',
    })),
  };
}

function createHandler(overrides: Record<string, unknown> = {}) {
  const sourceRefRepo =
    (overrides.sourceRefRepo as ReturnType<typeof mockSourceRefRepo>) ?? mockSourceRefRepo();
  const knowledgeRepo =
    (overrides.knowledgeRepo as ReturnType<typeof mockKnowledgeRepo>) ?? mockKnowledgeRepo();
  const contentPatcher =
    (overrides.contentPatcher as ReturnType<typeof mockContentPatcher>) ?? mockContentPatcher();
  const signalBus = (overrides.signalBus as ReturnType<typeof mockSignalBus>) ?? mockSignalBus();
  const gateway = (overrides.gateway as ReturnType<typeof mockGateway>) ?? mockGateway();

  const handler = new FileChangeHandler(
    sourceRefRepo as never,
    knowledgeRepo as never,
    contentPatcher as never,
    {
      signalBus: signalBus as never,
      evolutionGateway: gateway as never,
    }
  );

  return { handler, sourceRefRepo, knowledgeRepo, contentPatcher, signalBus, gateway };
}

/* ════════════════════════════════════════════
 *  Tests
 * ════════════════════════════════════════════ */

describe('FileChangeHandler', () => {
  beforeEach(() => {
    mockAssessFileImpact.mockReset();
    mockExtractRecipeTokens.mockReset();
    mockExtractRecipeTokens.mockReturnValue({ tokens: new Set(), sources: new Map() });
    // 默认：diff 返回 reference 级别（模拟有 git 环境）
    mockAssessFileImpact.mockReturnValue({ level: 'reference', score: 0, matchedTokens: [] });
  });

  /* ─── #handleModified → impactLevel ─── */

  describe('modified 事件 — impactLevel 判定', () => {
    test('sourceRef 匹配 + diff 返回 reference → 仅信号，不进 details', async () => {
      const { handler, sourceRefRepo, knowledgeRepo, signalBus } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Networking/AuthMiddleware.swift');
      knowledgeRepo._seed('r1', {
        title: 'AuthMiddleware 模式',
        coreCode: 'actor AuthMiddleware: Middleware {}',
        reasoning: { sources: ['Sources/Networking/AuthMiddleware.swift'] },
        trigger: '@auth-middleware',
      });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/Networking/AuthMiddleware.swift' },
      ]);

      // 文件不可读 → reference → 不进入 details
      expect(report.needsReview).toBe(0);
      expect(report.details).toHaveLength(0);
      // 但信号仍然发射
      expect(signalBus.send).toHaveBeenCalledWith(
        'quality',
        'FileChangeHandler',
        expect.any(Number),
        expect.objectContaining({ target: 'r1' })
      );
      expect(report.generationChangeLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'source-modified-reference',
            filePath: 'Sources/Networking/AuthMiddleware.swift',
            recipeId: 'r1',
          }),
        ])
      );
    });

    test('sourceRef 匹配多条 Recipe → 每条都发射信号', async () => {
      const { handler, sourceRefRepo, knowledgeRepo, signalBus } = createHandler();
      const sharedPath = 'Sources/Core/Middleware.swift';
      sourceRefRepo._seed('r1', sharedPath);
      sourceRefRepo._seed('r2', sharedPath);
      sourceRefRepo._seed('r3', sharedPath);
      knowledgeRepo._seed('r1', { title: 'Recipe A', coreCode: '' });
      knowledgeRepo._seed('r2', { title: 'Recipe B', coreCode: '' });
      knowledgeRepo._seed('r3', { title: 'Recipe C', coreCode: '' });

      const report = await handler.handleFileChanges([{ type: 'modified', path: sharedPath }]);

      // 文件不可读 → reference → 不进入 details
      expect(report.needsReview).toBe(0);
      // 但每条 Recipe 都发射了信号
      expect(signalBus.send).toHaveBeenCalledTimes(3);
    });

    test('deprecated Recipe 被跳过', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      knowledgeRepo._seed('r1', {
        title: 'Deprecated Recipe',
        lifecycle: 'deprecated',
        coreCode: '',
      });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/A.swift' },
      ]);

      expect(report.needsReview).toBe(0);
      expect(report.skipped).toBe(1);
      expect(report.details).toHaveLength(0);
    });

    test('staging Recipe 仍参与 modified 进化检查', async () => {
      mockAssessFileImpact.mockReturnValue({
        level: 'pattern',
        score: 0.5,
        matchedTokens: ['NetworkKitRetryPolicy'],
      });
      const { handler, sourceRefRepo, knowledgeRepo, gateway } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/RetryPolicy.swift');
      knowledgeRepo._seed('r1', {
        title: 'RetryPolicy 暂存知识',
        lifecycle: 'staging',
        coreCode: 'final class NetworkKitRetryPolicy {}',
      });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/RetryPolicy.swift' },
      ]);

      expect(report.skipped).toBe(0);
      expect(report.needsReview).toBe(1);
      expect(gateway.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          recipeId: 'r1',
          action: 'update',
          source: 'file-change',
        })
      );
    });

    test('无 sourceRef 匹配 → 跳过', async () => {
      const { handler } = createHandler();

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/Unknown.swift' },
      ]);

      expect(report.needsReview).toBe(0);
      expect(report.skipped).toBe(1);
    });
  });

  /* ─── Signal 发射验证 ─── */

  describe('modified 事件 — signal 发射', () => {
    test('sourceRef 匹配发射 quality signal（reference, weight=0.3）', async () => {
      const { handler, sourceRefRepo, knowledgeRepo, signalBus } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      knowledgeRepo._seed('r1', { title: 'Recipe A', coreCode: '' });

      await handler.handleFileChanges([{ type: 'modified', path: 'Sources/A.swift' }]);

      expect(signalBus.send).toHaveBeenCalledWith(
        'quality',
        'FileChangeHandler',
        0.3, // reference weight
        expect.objectContaining({
          target: 'r1',
          metadata: expect.objectContaining({
            reason: 'source_modified',
            modifiedPath: 'Sources/A.swift',
            impactLevel: 'reference',
          }),
        })
      );
    });
  });

  /* ─── suggestReview 策略 ─── */

  describe('suggestReview（Strategy C 验证）', () => {
    test('modified 无真实文件 → suggestReview=false（无 direct 影响）', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      knowledgeRepo._seed('r1', { title: 'Recipe A', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/A.swift' },
      ]);

      expect(report.suggestReview).toBe(false);
    });

    test('modified pattern 级别 → suggestReview=true', async () => {
      mockAssessFileImpact.mockReturnValue({
        level: 'pattern',
        score: 0.5,
        matchedTokens: ['fetchPopular'],
      });
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      knowledgeRepo._seed('r1', { title: 'Recipe A', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/A.swift' },
      ]);

      expect(report.suggestReview).toBe(true);
      expect(report.needsReview).toBe(1);
    });

    test('modified reference 级别 → suggestReview=false', async () => {
      mockAssessFileImpact.mockReturnValue({
        level: 'reference',
        score: 0.1,
        matchedTokens: ['client'],
      });
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      knowledgeRepo._seed('r1', { title: 'Recipe A', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/A.swift' },
      ]);

      expect(report.suggestReview).toBe(false);
      expect(report.needsReview).toBe(0);
    });

    test('deleted 事件 → suggestReview=true', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Dead.swift');
      knowledgeRepo._seed('r1', { title: 'Dead Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'deleted', path: 'Sources/Dead.swift' },
      ]);

      expect(report.suggestReview).toBe(true);
    });

    test('created 新模块 → 建议 module-mining，不写 Plan', async () => {
      const { handler, signalBus } = createHandler();

      const report = await handler.handleFileChanges([
        { type: 'created', path: 'Sources/New.swift' },
      ]);

      expect(report.suggestReview).toBe(true);
      expect(report.classificationCounts.newModuleRecommendations).toBe(1);
      expect(report.generationChangeLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'new-module-recommendation',
            filePath: 'Sources/New.swift',
          }),
        ])
      );
      expect(report.recommendations[0]).toMatchObject({
        path: 'Sources/New.swift',
        nextActions: expect.arrayContaining(['alembic_plan get']),
      });
      expect(report.planBoundary).toEqual({
        generationStateWrites: 0,
        planIntentWrites: 0,
        projectedFromExistingDbSources: true,
      });
      expect(signalBus.send).toHaveBeenCalledWith(
        'quality',
        'PluginUnifiedEvolution',
        0.6,
        expect.objectContaining({
          metadata: expect.objectContaining({
            reason: 'new-module-scope-recommendation',
          }),
        })
      );
    });
  });

  /* ─── deleted 事件 ─── */

  describe('deleted 事件', () => {
    test('所有 sourceRef 失效 → deprecate', async () => {
      const { handler, sourceRefRepo, knowledgeRepo, gateway } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Dead.swift');
      knowledgeRepo._seed('r1', { title: 'Dead Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'deleted', path: 'Sources/Dead.swift' },
      ]);

      expect(report.deprecated).toBe(1);
      expect(gateway.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          recipeId: 'r1',
          action: 'deprecate',
          confidence: 0.79,
        })
      );
      expect(gateway.submit.mock.calls[0]?.[0].confidence).toBeLessThan(0.8);
    });

    test('还有其他 active ref → 仅标记 stale', async () => {
      const { handler, sourceRefRepo, knowledgeRepo, gateway } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      sourceRefRepo._seed('r1', 'Sources/B.swift');
      knowledgeRepo._seed('r1', { title: 'Multi-ref Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'deleted', path: 'Sources/A.swift' },
      ]);

      expect(report.deprecated).toBe(0);
      expect(report.skipped).toBe(1);
      expect(gateway.submit).not.toHaveBeenCalled();
    });
  });

  /* ─── renamed 事件 ─── */

  describe('renamed 事件', () => {
    test('成功修复路径 → fixed', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Old.swift');
      knowledgeRepo._seed('r1', { title: 'Renamed Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'renamed', path: 'Sources/New.swift', oldPath: 'Sources/Old.swift' },
      ]);

      expect(report.fixed).toBe(1);
      expect(report.generationChangeLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'source-ref-repaired',
            oldPath: 'Sources/Old.swift',
            newPath: 'Sources/New.swift',
            recipeId: 'r1',
          }),
        ])
      );
      expect(sourceRefRepo.replaceSourcePath).toHaveBeenCalledWith(
        'r1',
        'Sources/Old.swift',
        'Sources/New.swift',
        expect.any(Number)
      );
    });

    test('带行号 sourceRef 的高置信 rename → 按文件路径匹配并保留行号修复', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Features/VideoFeed/VideoFeedViewModel.swift:1-78');
      knowledgeRepo._seed('r1', { title: 'VideoFeed Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        {
          eventSource: 'git-head',
          type: 'renamed',
          path: 'Sources/Features/VideoFeed/RG10VideoFeedViewModel.swift',
          oldPath: 'Sources/Features/VideoFeed/VideoFeedViewModel.swift',
        },
      ]);

      expect(report.fixed).toBe(1);
      expect(report.classificationCounts.repaired).toBe(1);
      expect(sourceRefRepo.replaceSourcePath).toHaveBeenCalledWith(
        'r1',
        'Sources/Features/VideoFeed/VideoFeedViewModel.swift:1-78',
        'Sources/Features/VideoFeed/RG10VideoFeedViewModel.swift:1-78',
        expect.any(Number)
      );
      expect(report.generationChangeLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'source-ref-repaired',
            oldPath: 'Sources/Features/VideoFeed/VideoFeedViewModel.swift:1-78',
            newPath: 'Sources/Features/VideoFeed/RG10VideoFeedViewModel.swift:1-78',
          }),
        ])
      );
    });

    test('低置信 rename → 指针修复 + update proposal', async () => {
      const { handler, sourceRefRepo, knowledgeRepo, gateway } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Old.swift');
      knowledgeRepo._seed('r1', { title: 'Renamed Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        {
          type: 'renamed',
          path: 'Sources/New.swift',
          oldPath: 'Sources/Old.swift',
          similarity: 0.5,
        } as FileChangeEvent,
      ]);

      expect(report.fixed).toBe(1);
      expect(report.needsReview).toBe(1);
      expect(report.classificationCounts.repaired).toBe(1);
      expect(report.classificationCounts.proposed).toBe(1);
      expect(report.pendingProposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'update',
            recipeId: 'r1',
            status: 'submitted',
          }),
        ])
      );
      expect(sourceRefRepo.replaceSourcePath).toHaveBeenCalledWith(
        'r1',
        'Sources/Old.swift',
        'Sources/New.swift',
        expect.any(Number)
      );
      expect(gateway.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          recipeId: 'r1',
          action: 'update',
          source: 'file-change',
        })
      );
    });

    test('已覆盖模块的 created 文件 → 不触发新模块建议', async () => {
      const { handler, sourceRefRepo, signalBus } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Core/Existing.swift');

      const report = await handler.handleFileChanges([
        { type: 'created', path: 'Sources/Core/New.swift' },
      ]);

      expect(report.suggestReview).toBe(false);
      expect(report.classificationCounts.coveredCreated).toBe(1);
      expect(report.classificationCounts.newModuleRecommendations).toBe(0);
      expect(signalBus.send).not.toHaveBeenCalledWith(
        'quality',
        'PluginUnifiedEvolution',
        expect.any(Number),
        expect.any(Object)
      );
    });
  });

  /* ─── diff-based 影响分析集成 ─── */

  describe('modified 事件 — diff-based 分析集成', () => {
    test('diff 返回 reference → 不进入 details', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      knowledgeRepo._seed('r1', { title: 'Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/A.swift' },
      ]);

      expect(report.details).toHaveLength(0);
      expect(report.needsReview).toBe(0);
    });

    test('diff 返回 null（无 git）→ 跳过，不发射信号', async () => {
      mockAssessFileImpact.mockReturnValue(null);
      const { handler, sourceRefRepo, knowledgeRepo, signalBus } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      knowledgeRepo._seed('r1', { title: 'Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/A.swift' },
      ]);

      expect(report.skipped).toBe(1);
      expect(report.details).toHaveLength(0);
      expect(signalBus.send).not.toHaveBeenCalled();
    });

    test('已提交 git-head modified 事件匹配带行号 sourceRef → 生成 review-needed changeLog', async () => {
      mockAssessFileImpact.mockReturnValue(null);
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed(
        'r1',
        'Sources/Infrastructure/Networking/Repository/FeedRepository.swift:1-69'
      );
      knowledgeRepo._seed('r1', { title: 'FeedRepository Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        {
          eventSource: 'git-head',
          type: 'modified',
          path: 'Sources/Infrastructure/Networking/Repository/FeedRepository.swift',
        },
      ]);

      expect(report.skipped).toBe(0);
      expect(report.needsReview).toBe(1);
      expect(report.generationChangeLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'source-modified-review-needed',
            filePath: 'Sources/Infrastructure/Networking/Repository/FeedRepository.swift',
            recipeId: 'r1',
          }),
        ])
      );
    });

    test('diff 返回 pattern → 进入 details + needsReview + 创建 update 提案', async () => {
      mockAssessFileImpact.mockReturnValue({
        level: 'pattern',
        score: 0.5,
        matchedTokens: ['fetchPopular', 'VideoModel'],
      });
      const { handler, sourceRefRepo, knowledgeRepo, signalBus, gateway } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      knowledgeRepo._seed('r1', { title: 'Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/A.swift' },
      ]);

      expect(report.needsReview).toBe(1);
      expect(report.details).toHaveLength(1);
      expect(report.details[0].action).toBe('needs-review');
      expect(report.details[0].impactLevel).toBe('pattern');
      expect(report.details[0].reason).toContain('fetchPopular');
      expect(signalBus.send).toHaveBeenCalledWith(
        'quality',
        'FileChangeHandler',
        expect.any(Number),
        expect.objectContaining({
          target: 'r1',
          metadata: expect.objectContaining({ impactLevel: 'pattern' }),
        })
      );

      // pattern 级别应通过 Gateway 持久化为 update 提案
      expect(gateway.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          recipeId: 'r1',
          action: 'update',
          source: 'file-change',
          confidence: expect.any(Number),
        })
      );
      expect(report.pendingProposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'update',
            filePath: 'Sources/A.swift',
            recipeId: 'r1',
          }),
        ])
      );
    });

    test('diff 返回 reference → 不创建提案', async () => {
      const { handler, sourceRefRepo, knowledgeRepo, gateway } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      knowledgeRepo._seed('r1', { title: 'Recipe', coreCode: '' });

      await handler.handleFileChanges([{ type: 'modified', path: 'Sources/A.swift' }]);

      // reference 级别不应创建提案
      expect(gateway.submit).not.toHaveBeenCalled();
    });
  });

  /* ─── 旧 Bug 回归验证 ─── */

  describe('Bug 回归', () => {
    test('[回归] deprecated Recipe 被跳过不误报', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Middleware/AuthMiddleware.swift');
      knowledgeRepo._seed('r1', {
        title: '并发模型演进',
        lifecycle: 'deprecated',
        coreCode: 'actor AuthMiddleware: Middleware {}',
      });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/Middleware/AuthMiddleware.swift' },
      ]);

      expect(report.skipped).toBe(1);
      expect(report.needsReview).toBe(0);
    });

    test('[回归] deleted 事件正确触发 deprecate，不受内容分析影响', async () => {
      const { handler, sourceRefRepo, knowledgeRepo, gateway } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Core/ServiceRegistry.swift');
      knowledgeRepo._seed('r1', {
        title: 'ServiceRegistry 依赖注入',
        coreCode: 'class Container { }',
      });

      const report = await handler.handleFileChanges([
        { type: 'deleted', path: 'Sources/Core/ServiceRegistry.swift' },
      ]);

      expect(report.deprecated).toBe(1);
      expect(gateway.submit).toHaveBeenCalledWith(expect.objectContaining({ action: 'deprecate' }));
    });

    test('[回归] modified 事件信号发射包含正确的 recipeId', async () => {
      const { handler, sourceRefRepo, knowledgeRepo, signalBus } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Middleware.swift');
      knowledgeRepo._seed('r1', {
        title: 'Recipe',
        coreCode: '',
      });

      await handler.handleFileChanges([{ type: 'modified', path: 'Sources/Middleware.swift' }]);

      expect(signalBus.send).toHaveBeenCalledWith(
        'quality',
        'FileChangeHandler',
        expect.any(Number),
        expect.objectContaining({
          target: 'r1',
          metadata: expect.objectContaining({ reason: 'source_modified' }),
        })
      );
    });
  });
});
