import {
  assessFileImpact,
  type EvolutionGateway,
  extractRecipeTokens,
} from '@alembic/core/evolution';
import type { RecipeFreshnessEntry, RecipeFreshnessService } from '@alembic/core/knowledge';
import type {
  FileChangeEvent,
  FileChangeEventSource,
  ImpactLevel,
  ReactiveEvolutionReport,
  StructuredPatch,
} from '@alembic/core/types';

type SourceRefRow = {
  recipeId: string;
  sourcePath: string;
  status?: string;
  newPath?: string | null;
};

type KnowledgeEntryLike = {
  id: string;
  title?: string;
  lifecycle?: string;
  coreCode?: string;
  reasoning?: unknown;
  sourceFile?: string | null;
  [key: string]: unknown;
};

interface SourceRefRepositoryLike {
  findAll?(): SourceRefRow[];
  findByRecipeId(recipeId: string): SourceRefRow[];
  findBySourcePath(sourcePath: string): SourceRefRow[];
  replaceSourcePath(
    recipeId: string,
    oldSourcePath: string,
    newSourcePath: string,
    verifiedAt: number
  ): void;
  upsert?(data: {
    newPath?: string | null;
    recipeId: string;
    sourcePath: string;
    status?: string;
    verifiedAt: number;
  }): void;
}

interface KnowledgeRepositoryLike {
  findById(recipeId: string): Promise<KnowledgeEntryLike | null> | KnowledgeEntryLike | null;
  updateReasoning?(id: string, reasoning: string, updatedAt: number): Promise<boolean> | boolean;
}

interface SignalBusLike {
  send(type: string, source: string, weight: number, opts: Record<string, unknown>): void;
}

export interface HostAgentFileChangeHandlerOptions {
  evolutionGateway?: Pick<EvolutionGateway, 'submit'> | null;
  projectRoot?: string;
  recipeFreshnessService?: Pick<RecipeFreshnessService, 'refreshRecipes'> | null;
  renameAutoRepairThreshold?: number;
  signalBus?: SignalBusLike | null;
}

// UM#1：created→moduleMining 生成已退役。保留 UnifiedEvolutionModuleMiningRoute 类型与 report 上
// 恒空的 moduleMiningRoutes 字段，纯为 surface/output/routing 消费方的向后兼容（schema 不变、恒空）；
// 不再有任何代码向其写入路由。生成型模块挖掘分析器接口与入参类型已随退役一并删除。
export interface UnifiedEvolutionModuleMiningRoute {
  fileCount: number;
  moduleId: string;
  moduleScope: string[];
  path: string;
  reason: string;
  requestKinds: string[];
  status: 'routed' | 'failed';
  error?: string;
  moduleCount?: number;
  moduleSeedCount?: number;
}

export interface UnifiedEvolutionProposalSignal {
  action: 'deprecate' | 'update';
  confidence: number;
  description: string;
  filePath: string;
  recipeId: string;
  source: string;
  status: 'submitted' | 'unavailable';
  proposalId?: string;
}

export interface UnifiedEvolutionChangeLogEntry {
  action: string;
  createdAt: number;
  filePath: string;
  reason: string;
  eventSource?: FileChangeEventSource;
  newPath?: string;
  oldPath?: string;
  recipeId?: string;
}

export interface UnifiedEvolutionReport extends ReactiveEvolutionReport {
  classificationCounts: {
    coveredCreated: number;
    created: number;
    deleted: number;
    deprecationProposals: number;
    // moduleMiningRoutes：UM#1 退役后恒为 0（无生成路由）；保留为向后兼容字段。
    moduleMiningRoutes: number;
    modified: number;
    proposed: number;
    renamed: number;
    repaired: number;
    skipped: number;
    // UM#5（⑤b）：未被 recipe_source_refs 覆盖的新建文件计数（生成已退役，纯诊断、非生成）。
    uncoveredCreated: number;
  };
  generationChangeLog: UnifiedEvolutionChangeLogEntry[];
  freshness?: {
    processed: number;
    recipeIds: string[];
    retrievalMayBeStale: boolean;
    status: string;
  };
  planBoundary: {
    generationStateWrites: 0;
    planIntentWrites: 0;
    projectedFromExistingDbSources: true;
  };
  moduleMiningRoutes: UnifiedEvolutionModuleMiningRoute[];
  pendingProposals: UnifiedEvolutionProposalSignal[];
}

const DEFAULT_RENAME_AUTO_REPAIR_THRESHOLD = 0.9;
const FILE_CHANGE_PROPOSAL_SOURCE = 'file-change';

export class HostAgentFileChangeHandler {
  readonly #evolutionGateway: Pick<EvolutionGateway, 'submit'> | null;
  readonly #knowledgeRepo: KnowledgeRepositoryLike;
  readonly #projectRoot: string;
  readonly #recipeFreshnessService: Pick<RecipeFreshnessService, 'refreshRecipes'> | null;
  readonly #renameAutoRepairThreshold: number;
  readonly #signalBus: SignalBusLike | null;
  readonly #sourceRefRepo: SourceRefRepositoryLike;

  constructor(
    sourceRefRepo: SourceRefRepositoryLike,
    knowledgeRepo: KnowledgeRepositoryLike,
    _contentPatcher?: unknown,
    options: HostAgentFileChangeHandlerOptions = {}
  ) {
    this.#sourceRefRepo = sourceRefRepo;
    this.#knowledgeRepo = knowledgeRepo;
    this.#evolutionGateway = options.evolutionGateway ?? null;
    this.#projectRoot = options.projectRoot ?? process.cwd();
    this.#recipeFreshnessService = options.recipeFreshnessService ?? null;
    this.#renameAutoRepairThreshold =
      options.renameAutoRepairThreshold ?? DEFAULT_RENAME_AUTO_REPAIR_THRESHOLD;
    this.#signalBus = options.signalBus ?? null;
  }

  async handleFileChanges(
    events: FileChangeEvent[],
    // maint-fix-plugin：commit-range（如 `mergeBase..HEAD`，来自 scanner 的 scan.range）。仅 git-head
    // （committed）事件用它走 commit-range diff；工作树事件不传=默认 `git diff HEAD`（向后兼容、字节不变）。
    commitRange?: string
  ): Promise<UnifiedEvolutionReport> {
    const report = createReport(events);
    const freshnessIds = new Set<string>();
    const freshnessEntries = new Map<string, KnowledgeEntryLike>();

    for (const event of events) {
      switch (event.type) {
        case 'renamed':
          await this.#handleRenamed(event, report, freshnessIds, freshnessEntries);
          break;
        case 'modified':
          await this.#handleModified(event, report, commitRange);
          break;
        case 'deleted':
          await this.#handleDeleted(event, report);
          break;
        case 'created':
          await this.#handleCreated(event, report);
          break;
      }
    }

    await this.#refreshAffectedRecipes(report, [...freshnessIds], freshnessEntries);
    report.classificationCounts.skipped = report.skipped;
    // UM#1：moduleMining 生成已退役（moduleMiningRoutes 恒空），suggestReview 只取决于真实的待审/弃用。
    report.suggestReview = report.needsReview > 0 || report.deprecated > 0;
    return report;
  }

  async #handleRenamed(
    event: FileChangeEvent,
    report: UnifiedEvolutionReport,
    freshnessIds: Set<string>,
    freshnessEntries: Map<string, KnowledgeEntryLike>
  ): Promise<void> {
    report.classificationCounts.renamed++;
    if (!event.oldPath) {
      report.skipped++;
      return;
    }
    const refs = this.#activeRefsForPath(event.oldPath);
    if (refs.length === 0) {
      report.skipped++;
      return;
    }

    const confidence = renameConfidence(event);
    for (const ref of refs) {
      const entry = await this.#loadEntry(ref.recipeId);
      if (!entry || isDeprecated(entry)) {
        report.skipped++;
        continue;
      }
      const repairedSourcePath = repairSourceRefPath(ref.sourcePath, event.path);
      const oldSourcePath = ref.sourcePath;
      this.#sourceRefRepo.replaceSourcePath(
        ref.recipeId,
        oldSourcePath,
        repairedSourcePath,
        Date.now()
      );
      const refreshedEntry = await this.#persistReasoningSourcePathRepair(
        entry,
        oldSourcePath,
        repairedSourcePath
      );
      freshnessIds.add(ref.recipeId);
      freshnessEntries.set(ref.recipeId, refreshedEntry);
      report.fixed++;
      report.classificationCounts.repaired++;
      report.generationChangeLog.push({
        action: 'source-ref-repaired',
        createdAt: Date.now(),
        eventSource: event.eventSource,
        filePath: repairedSourcePath,
        newPath: repairedSourcePath,
        oldPath: oldSourcePath,
        reason: `High-confidence rename repaired Recipe sourceRef ${oldSourcePath} -> ${repairedSourcePath}.`,
        recipeId: ref.recipeId,
      });
      if (confidence < this.#renameAutoRepairThreshold) {
        const proposal = await this.#submitUpdateProposal(entry, event.path, {
          currentCode: '',
          impactLevel: 'reference',
          matchedTokens: [],
          reason: `Low-confidence rename ${event.oldPath} -> ${event.path}; pointer repaired, content review recommended.`,
        });
        report.pendingProposals.push(proposal);
        report.needsReview++;
        report.classificationCounts.proposed++;
      }
    }
  }

  async #handleModified(
    event: FileChangeEvent,
    report: UnifiedEvolutionReport,
    commitRange?: string
  ): Promise<void> {
    report.classificationCounts.modified++;
    const refs = this.#activeRefsForPath(event.path);
    if (refs.length === 0) {
      report.skipped++;
      return;
    }

    for (const ref of refs) {
      const entry = await this.#loadEntry(ref.recipeId);
      if (!entry || isDeprecated(entry)) {
        report.skipped++;
        continue;
      }

      const tokens = extractRecipeTokens(entry);
      // maint-fix-plugin：git-head（committed）事件用 commit-range diff——工作树在 commit 后已为空，必须用
      // scanner 算出的 commit-range（scan.range）才能拿到真实改动做影响评估，否则恒零命中被 LP7 误 skip。
      // 非 git-head（工作树）事件传 undefined=默认 `git diff HEAD`，与改前逐字节一致（向后兼容）。
      const revisionRange = event.eventSource === 'git-head' ? commitRange : undefined;
      const impact = assessFileImpact(this.#projectRoot, event.path, tokens, revisionRange);
      if (!impact) {
        if (event.eventSource === 'git-head') {
          // LP7（CG-5）+ maint-fix-plugin：git-head 事件现在用 commit-range diff（scan.range）做影响评估，
          // 故 committed-impactful 改动能拿到真实 token 命中（不再误零命中——订正旧注释「工作树 diff 已不可得」）。
          // 此处只剩「commit-range 内零 token 命中」= trivial committed 改动（无 Recipe 相关变更）。LP7 精确抑制：
          // 不提无证据 reference 提案，降级为 generationChangeLog 记录 + skipped++（可观测、非提案），
          // 不进 pendingProposals/needsReview。有 token 命中（impact 非空）的改动走下方正常 update 提案——
          // 这正是 committed→propose 收口。
          report.generationChangeLog.push({
            action: 'source-modified-git-head-no-impact',
            createdAt: Date.now(),
            eventSource: event.eventSource,
            filePath: event.path,
            reason:
              'Committed git-head event modified covered source but no Recipe-relevant tokens matched (zero-impact); recorded for observability without routing a review proposal.',
            recipeId: entry.id,
          });
        }
        report.skipped++;
        continue;
      }
      this.#emitSourceModified(entry.id, event.path, impact.level, impact.score);
      report.generationChangeLog.push({
        action:
          impact.level === 'reference'
            ? 'source-modified-reference'
            : 'source-modified-review-needed',
        createdAt: Date.now(),
        eventSource: event.eventSource,
        filePath: event.path,
        reason:
          impact.matchedTokens.join(', ') ||
          `Modified covered source ${event.path} touched Recipe evidence.`,
        recipeId: entry.id,
      });
      if (impact.level === 'reference') {
        continue;
      }

      const proposal = await this.#submitUpdateProposal(entry, event.path, {
        currentCode: '',
        impactLevel: impact.level,
        matchedTokens: impact.matchedTokens,
        reason: `Modified covered source ${event.path} changed Recipe-relevant tokens: ${impact.matchedTokens.join(', ') || 'pattern match'}.`,
      });
      report.pendingProposals.push(proposal);
      report.needsReview++;
      report.classificationCounts.proposed++;
      report.details.push({
        action: 'needs-review',
        impactLevel: impact.level,
        modifiedPath: event.path,
        reason: impact.matchedTokens.join(', ') || 'Recipe-relevant source changed',
        recipeId: entry.id,
        recipeTitle: entry.title ?? entry.id,
      });
    }
  }

  async #handleDeleted(event: FileChangeEvent, report: UnifiedEvolutionReport): Promise<void> {
    report.classificationCounts.deleted++;
    const refs = this.#activeRefsForPath(event.path);
    if (refs.length === 0) {
      report.skipped++;
      return;
    }

    for (const ref of refs) {
      const entry = await this.#loadEntry(ref.recipeId);
      if (!entry || isDeprecated(entry)) {
        report.skipped++;
        continue;
      }
      const activeRefs = this.#activeRefsForRecipe(ref.recipeId);
      const deletedComparablePath = normalizeComparableSourcePath(event.path);
      if (
        activeRefs.some(
          (active) => normalizeComparableSourcePath(active.sourcePath) !== deletedComparablePath
        )
      ) {
        this.#markSourceRefStale(ref.recipeId, ref.sourcePath);
        report.generationChangeLog.push({
          action: 'source-ref-stale',
          createdAt: Date.now(),
          eventSource: event.eventSource,
          filePath: ref.sourcePath,
          reason: `Deleted source ${ref.sourcePath} marked stale because Recipe keeps other active sourceRefs.`,
          recipeId: ref.recipeId,
        });
        report.skipped++;
        continue;
      }

      const proposal = await this.#submitDeprecationProposal(entry, event.path);
      report.pendingProposals.push(proposal);
      report.deprecated++;
      report.classificationCounts.deprecationProposals++;
      report.details.push({
        action: 'deprecate',
        reason: `Deleted covered source ${event.path}; deprecation proposal created instead of deleting Recipe evidence.`,
        recipeId: entry.id,
        recipeTitle: entry.title ?? entry.id,
      });
    }
  }

  async #handleCreated(event: FileChangeEvent, report: UnifiedEvolutionReport): Promise<void> {
    report.classificationCounts.created++;
    const moduleId = moduleIdForPath(event.path);
    if (!moduleId) {
      report.skipped++;
      return;
    }

    // 命中既有 recipe_source_refs 覆盖 = 维护范畴（既有 Recipe 的演进由 modified/deleted 路径处理），
    // 不在此生成；仅计数。
    if (this.#activeRefsForPath(event.path).length > 0) {
      report.classificationCounts.coveredCreated++;
      return;
    }

    // UM#1/#5：退役 created→moduleMining 生成路径。未被任何 recipe_source_refs 覆盖的新文件不再调
    // moduleMiningAnalyzer 种新 Recipe（不写 plan/生成 state、不发生成质量信号、不提任何提案、不进
    // moduleMiningRoutes）。commit-driven 维护链只对既有 Recipe 建/更新/弃用 proposal；新文件的首次
    // 覆盖由 coldStart/deepMining 等专职生成链负责（另需求），不属本维护链。此处仅留纯计数诊断
    // （⑤b：可观测、非生成、不触发任何生成/分析）。
    report.classificationCounts.uncoveredCreated++;
    report.skipped++;
  }

  #activeRefsForPath(path: string): SourceRefRow[] {
    const exactRefs = this.#sourceRefRepo
      .findBySourcePath(path)
      .filter((ref) => ref.status !== 'stale');
    if (exactRefs.length > 0 || !this.#sourceRefRepo.findAll) {
      return exactRefs;
    }
    const comparablePath = normalizeComparableSourcePath(path);
    return uniqueSourceRefs(
      this.#sourceRefRepo
        .findAll()
        .filter(
          (ref) =>
            ref.status !== 'stale' &&
            normalizeComparableSourcePath(ref.sourcePath) === comparablePath
        )
    );
  }

  #activeRefsForRecipe(recipeId: string): SourceRefRow[] {
    return this.#sourceRefRepo.findByRecipeId(recipeId).filter((ref) => ref.status !== 'stale');
  }

  async #loadEntry(recipeId: string): Promise<KnowledgeEntryLike | null> {
    return await this.#knowledgeRepo.findById(recipeId);
  }

  #markSourceRefStale(recipeId: string, sourcePath: string): void {
    this.#sourceRefRepo.upsert?.({
      recipeId,
      sourcePath,
      status: 'stale',
      verifiedAt: Date.now(),
    });
  }

  async #persistReasoningSourcePathRepair(
    entry: KnowledgeEntryLike,
    oldSourcePath: string,
    newSourcePath: string
  ): Promise<KnowledgeEntryLike> {
    const repairedReasoning = replaceReasoningSourcePath(
      entry.reasoning,
      oldSourcePath,
      newSourcePath
    );
    if (!repairedReasoning.changed) {
      return entry;
    }
    await this.#knowledgeRepo.updateReasoning?.(
      entry.id,
      JSON.stringify(repairedReasoning.value),
      Date.now()
    );
    return { ...entry, reasoning: repairedReasoning.value };
  }

  async #submitUpdateProposal(
    entry: KnowledgeEntryLike,
    filePath: string,
    input: {
      currentCode: string;
      impactLevel: ImpactLevel;
      matchedTokens: string[];
      reason: string;
    }
  ): Promise<UnifiedEvolutionProposalSignal> {
    const payload = {
      action: 'update' as const,
      confidence: input.impactLevel === 'direct' ? 0.86 : 0.72,
      description: input.reason,
      evidence: [
        {
          currentCode: input.currentCode,
          filePath,
          impactLevel: input.impactLevel,
          matchedTokens: input.matchedTokens,
          sourceStatus: 'modified',
          suggestedChanges: buildUpdateSuggestedChangesPatch(filePath, input),
          verifiedAt: Date.now(),
          verifiedBy: 'commit-driven-unified-evolution',
        },
      ],
      recipeId: entry.id,
      source: FILE_CHANGE_PROPOSAL_SOURCE as 'file-change',
    };
    const result = await this.#evolutionGateway?.submit(payload);
    return {
      action: payload.action,
      confidence: payload.confidence,
      description: payload.description,
      filePath,
      ...(readResultId(result) ? { proposalId: readResultId(result) } : {}),
      recipeId: entry.id,
      source: FILE_CHANGE_PROPOSAL_SOURCE,
      status: this.#evolutionGateway ? 'submitted' : 'unavailable',
    };
  }

  async #submitDeprecationProposal(
    entry: KnowledgeEntryLike,
    filePath: string
  ): Promise<UnifiedEvolutionProposalSignal> {
    const payload = {
      action: 'deprecate' as const,
      confidence: 0.79,
      description: `Covered source was deleted: ${filePath}`,
      evidence: [
        {
          filePath,
          sourceStatus: 'deleted',
          verifiedAt: Date.now(),
          verifiedBy: 'commit-driven-unified-evolution',
        },
      ],
      recipeId: entry.id,
      reason: `Covered source was deleted: ${filePath}`,
      source: FILE_CHANGE_PROPOSAL_SOURCE as 'file-change',
    };
    const result = await this.#evolutionGateway?.submit(payload);
    return {
      action: payload.action,
      confidence: payload.confidence,
      description: payload.description,
      filePath,
      ...(readResultId(result) ? { proposalId: readResultId(result) } : {}),
      recipeId: entry.id,
      source: FILE_CHANGE_PROPOSAL_SOURCE,
      status: this.#evolutionGateway ? 'submitted' : 'unavailable',
    };
  }

  #emitSourceModified(
    recipeId: string,
    modifiedPath: string,
    impactLevel: ImpactLevel,
    score: number
  ): void {
    this.#signalBus?.send(
      'quality',
      'HostAgentFileChangeHandler',
      signalWeight(impactLevel, score),
      {
        target: recipeId,
        metadata: {
          impactLevel,
          modifiedPath,
          reason: 'source_modified',
        },
      }
    );
  }

  async #refreshAffectedRecipes(
    report: UnifiedEvolutionReport,
    recipeIds: string[],
    entryOverrides: Map<string, KnowledgeEntryLike>
  ): Promise<void> {
    if (!this.#recipeFreshnessService || recipeIds.length === 0) {
      return;
    }
    const entries = (
      await Promise.all(
        recipeIds.map(async (id) => entryOverrides.get(id) ?? (await this.#loadEntry(id)))
      )
    )
      .filter((entry): entry is KnowledgeEntryLike => Boolean(entry?.id))
      .map((entry) => entry as unknown as RecipeFreshnessEntry);
    if (entries.length === 0) {
      return;
    }
    const result = await this.#recipeFreshnessService.refreshRecipes(entries, {
      maxRecipes: entries.length,
    });
    report.freshness = {
      processed: result.processed,
      recipeIds: result.recipes.map((recipe) => recipe.recipeId),
      retrievalMayBeStale: result.retrievalMayBeStale,
      status: result.status,
    };
  }
}

function createReport(events: readonly FileChangeEvent[]): UnifiedEvolutionReport {
  return {
    classificationCounts: {
      coveredCreated: 0,
      created: 0,
      deleted: 0,
      deprecationProposals: 0,
      moduleMiningRoutes: 0,
      modified: 0,
      proposed: 0,
      renamed: 0,
      repaired: 0,
      skipped: 0,
      uncoveredCreated: 0,
    },
    deprecated: 0,
    details: [],
    eventSource: dominantEventSource(events),
    fixed: 0,
    generationChangeLog: [],
    moduleMiningRoutes: [],
    needsReview: 0,
    pendingProposals: [],
    planBoundary: {
      generationStateWrites: 0,
      planIntentWrites: 0,
      projectedFromExistingDbSources: true,
    },
    skipped: 0,
    suggestReview: false,
  };
}

export function isUnifiedEvolutionReportRouteComplete(report: UnifiedEvolutionReport): boolean {
  // UM#1：moduleMining 生成已退役（moduleMiningRoutes 恒空），路由完整性只取决于提案是否落库。
  return report.pendingProposals.every((proposal) => proposal.status === 'submitted');
}

export function describeUnifiedEvolutionRouteIncomplete(
  report: UnifiedEvolutionReport
): string | null {
  const unavailableProposal = report.pendingProposals.find(
    (proposal) => proposal.status !== 'submitted'
  );
  if (unavailableProposal) {
    return `Update/deprecation proposal for ${unavailableProposal.recipeId} was not submitted.`;
  }
  return null;
}

function isDeprecated(entry: KnowledgeEntryLike): boolean {
  return entry.lifecycle === 'deprecated';
}

function readResultId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['proposalId', 'id']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function buildUpdateSuggestedChangesPatch(
  filePath: string,
  input: {
    currentCode: string;
    impactLevel: ImpactLevel;
    matchedTokens: string[];
    reason: string;
  }
): string {
  const codeExcerpt = trimForPatchEvidence(input.currentCode);
  const tokenLine =
    input.matchedTokens.length > 0
      ? input.matchedTokens.slice(0, 12).join(', ')
      : 'no token match reported';
  const evidenceBlock = [
    '### Source change evidence',
    '',
    `- Source: ${filePath}`,
    `- Impact: ${input.impactLevel}`,
    `- Matched tokens: ${tokenLine}`,
    `- Reason: ${input.reason}`,
    '',
    'Current code excerpt:',
    '```',
    codeExcerpt || '(empty or unreadable source excerpt)',
    '```',
  ].join('\n');
  const patch: StructuredPatch = {
    patchVersion: 1,
    changes: [
      {
        field: 'content.markdown',
        action: 'append',
        newValue: evidenceBlock,
      },
    ],
    reasoning: input.reason,
  };
  return JSON.stringify(patch);
}

function trimForPatchEvidence(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 2000) {
    return trimmed;
  }
  return `${trimmed.slice(0, 2000)}\n...`;
}

function replaceReasoningSourcePath(
  reasoning: unknown,
  oldSourcePath: string,
  newSourcePath: string
): { changed: boolean; value: unknown } {
  const parsed = parseReasoning(reasoning);
  if (!parsed || !Array.isArray(parsed.sources)) {
    return { changed: false, value: reasoning };
  }
  let changed = false;
  const sources = parsed.sources.map((source) => {
    if (source === oldSourcePath) {
      changed = true;
      return newSourcePath;
    }
    return source;
  });
  if (!changed) {
    return { changed: false, value: reasoning };
  }
  return { changed: true, value: { ...parsed, sources } };
}

function parseReasoning(value: unknown): { sources?: unknown[]; [key: string]: unknown } | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as { sources?: unknown[]; [key: string]: unknown };
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { sources?: unknown[]; [key: string]: unknown })
      : null;
  } catch {
    return null;
  }
}

function renameConfidence(event: FileChangeEvent): number {
  const similarity = (event as FileChangeEvent & { similarity?: unknown }).similarity;
  return typeof similarity === 'number' && Number.isFinite(similarity) ? similarity : 1;
}

function moduleIdForPath(filePath: string): string | null {
  const parts = normalizeComparableSourcePath(filePath).split('/').filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return `${parts[0]}/${parts[1]}`;
}

function signalWeight(impactLevel: ImpactLevel, score: number): number {
  if (impactLevel === 'direct') {
    return Math.max(0.7, score);
  }
  if (impactLevel === 'pattern') {
    return Math.max(0.5, score);
  }
  return 0.3;
}

function dominantEventSource(
  events: readonly FileChangeEvent[]
): FileChangeEventSource | undefined {
  const counts = new Map<FileChangeEventSource, number>();
  for (const event of events) {
    if (!event.eventSource) {
      continue;
    }
    counts.set(event.eventSource, (counts.get(event.eventSource) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

function normalizeComparableSourcePath(sourceRef: string): string {
  const { filePath } = splitSourceRefLocation(sourceRef);
  return filePath.replace(/^\.\//, '');
}

function repairSourceRefPath(sourceRef: string, newFilePath: string): string {
  const { lineSuffix } = splitSourceRefLocation(sourceRef);
  return `${normalizeComparableSourcePath(newFilePath)}${lineSuffix}`;
}

function splitSourceRefLocation(sourceRef: string): { filePath: string; lineSuffix: string } {
  const trimmed = sourceRef.trim();
  const lineMatch = /^(.*?)(:\d+(?:-\d+)?)$/.exec(trimmed);
  if (!lineMatch) {
    return { filePath: trimmed, lineSuffix: '' };
  }
  return {
    filePath: lineMatch[1] ?? trimmed,
    lineSuffix: lineMatch[2] ?? '',
  };
}

function uniqueSourceRefs(refs: SourceRefRow[]): SourceRefRow[] {
  const seen = new Set<string>();
  const unique: SourceRefRow[] = [];
  for (const ref of refs) {
    const key = `${ref.recipeId}\0${ref.sourcePath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}
