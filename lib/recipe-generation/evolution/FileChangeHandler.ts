import { ModuleDeltaDetector } from '@alembic/core/dimensions';
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
}

interface SignalBusLike {
  send(type: string, source: string, weight: number, opts: Record<string, unknown>): void;
}

export interface FileChangeHandlerOptions {
  evolutionGateway?: Pick<EvolutionGateway, 'submit'> | null;
  projectRoot?: string;
  recipeFreshnessService?: Pick<RecipeFreshnessService, 'refreshRecipes'> | null;
  renameAutoRepairThreshold?: number;
  signalBus?: SignalBusLike | null;
}

export interface UnifiedEvolutionRecommendation {
  moduleId: string;
  path: string;
  reason: string;
  nextActions: string[];
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
    modified: number;
    newModuleRecommendations: number;
    proposed: number;
    renamed: number;
    repaired: number;
    skipped: number;
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
  pendingProposals: UnifiedEvolutionProposalSignal[];
  recommendations: UnifiedEvolutionRecommendation[];
}

const DEFAULT_RENAME_AUTO_REPAIR_THRESHOLD = 0.9;
const FILE_CHANGE_PROPOSAL_SOURCE = 'file-change';

export class FileChangeHandler {
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
    options: FileChangeHandlerOptions = {}
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

  async handleFileChanges(events: FileChangeEvent[]): Promise<UnifiedEvolutionReport> {
    const report = createReport(events);
    const freshnessIds = new Set<string>();

    for (const event of events) {
      switch (event.type) {
        case 'renamed':
          await this.#handleRenamed(event, report, freshnessIds);
          break;
        case 'modified':
          await this.#handleModified(event, report);
          break;
        case 'deleted':
          await this.#handleDeleted(event, report);
          break;
        case 'created':
          this.#handleCreated(event, report);
          break;
      }
    }

    await this.#refreshAffectedRecipes(report, [...freshnessIds]);
    report.classificationCounts.skipped = report.skipped;
    report.suggestReview =
      report.needsReview > 0 ||
      report.deprecated > 0 ||
      report.recommendations.length > 0 ||
      report.classificationCounts.newModuleRecommendations > 0;
    return report;
  }

  async #handleRenamed(
    event: FileChangeEvent,
    report: UnifiedEvolutionReport,
    freshnessIds: Set<string>
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
      this.#sourceRefRepo.replaceSourcePath(
        ref.recipeId,
        ref.sourcePath,
        repairedSourcePath,
        Date.now()
      );
      freshnessIds.add(ref.recipeId);
      report.fixed++;
      report.classificationCounts.repaired++;
      report.generationChangeLog.push({
        action: 'source-ref-repaired',
        createdAt: Date.now(),
        eventSource: event.eventSource,
        filePath: repairedSourcePath,
        newPath: repairedSourcePath,
        oldPath: ref.sourcePath,
        reason: `High-confidence rename repaired Recipe sourceRef ${ref.sourcePath} -> ${repairedSourcePath}.`,
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

  async #handleModified(event: FileChangeEvent, report: UnifiedEvolutionReport): Promise<void> {
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
      const impact = assessFileImpact(this.#projectRoot, event.path, tokens);
      if (!impact) {
        if (event.eventSource === 'git-head') {
          report.needsReview++;
          report.generationChangeLog.push({
            action: 'source-modified-review-needed',
            createdAt: Date.now(),
            eventSource: event.eventSource,
            filePath: event.path,
            reason:
              'Committed git-head event modified covered source; working-tree diff content is no longer available, so host review is required.',
            recipeId: entry.id,
          });
          report.details.push({
            action: 'needs-review',
            impactLevel: 'reference',
            modifiedPath: event.path,
            reason: 'Committed git-head modification touched a covered sourceRef',
            recipeId: entry.id,
            recipeTitle: entry.title ?? entry.id,
          });
          continue;
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

  #handleCreated(event: FileChangeEvent, report: UnifiedEvolutionReport): void {
    report.classificationCounts.created++;
    const moduleId = moduleIdForPath(event.path);
    if (!moduleId) {
      report.skipped++;
      return;
    }

    const coveredModules = new Set(
      this.#allSourceRefs()
        .map((ref) => moduleIdForPath(ref.sourcePath))
        .filter((value): value is string => Boolean(value))
    );
    if (coveredModules.has(moduleId)) {
      report.classificationCounts.coveredCreated++;
      return;
    }

    const delta = new ModuleDeltaDetector().detect({
      previousModules: [...coveredModules].map((id) => ({ moduleId: id, moduleName: id })),
      currentModules: [
        ...[...coveredModules].map((id) => ({ moduleId: id, moduleName: id })),
        { files: [event.path], moduleId, moduleName: moduleId },
      ],
      changedFiles: [event.path],
      renameSimilarityThreshold: 0.9,
    });
    const added = delta.added.some((change) => change.moduleId === moduleId);
    if (!added) {
      report.skipped++;
      return;
    }

    const recommendation = {
      moduleId,
      path: event.path,
      reason: 'created path appears in a new module without existing recipe_source_refs coverage',
      nextActions: [
        'alembic_plan get',
        'alembic_rescan { generationStage: "moduleMining", moduleScope: [...] }',
      ],
    };
    report.recommendations.push(recommendation);
    report.classificationCounts.newModuleRecommendations++;
    report.generationChangeLog.push({
      action: 'new-module-recommendation',
      createdAt: Date.now(),
      eventSource: event.eventSource,
      filePath: event.path,
      reason: recommendation.reason,
    });
    this.#signalBus?.send('quality', 'PluginUnifiedEvolution', 0.6, {
      metadata: {
        reason: 'new-module-scope-recommendation',
        moduleId,
        path: event.path,
        nextActions: recommendation.nextActions,
      },
    });
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

  #allSourceRefs(): SourceRefRow[] {
    if (this.#sourceRefRepo.findAll) {
      return this.#sourceRefRepo.findAll();
    }
    return [];
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
          suggestedChanges: input.reason,
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
    this.#signalBus?.send('quality', 'FileChangeHandler', signalWeight(impactLevel, score), {
      target: recipeId,
      metadata: {
        impactLevel,
        modifiedPath,
        reason: 'source_modified',
      },
    });
  }

  async #refreshAffectedRecipes(
    report: UnifiedEvolutionReport,
    recipeIds: string[]
  ): Promise<void> {
    if (!this.#recipeFreshnessService || recipeIds.length === 0) {
      return;
    }
    const entries = (await Promise.all(recipeIds.map((id) => this.#loadEntry(id))))
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
      modified: 0,
      newModuleRecommendations: 0,
      proposed: 0,
      renamed: 0,
      repaired: 0,
      skipped: 0,
    },
    deprecated: 0,
    details: [],
    eventSource: dominantEventSource(events),
    fixed: 0,
    generationChangeLog: [],
    needsReview: 0,
    pendingProposals: [],
    planBoundary: {
      generationStateWrites: 0,
      planIntentWrites: 0,
      projectedFromExistingDbSources: true,
    },
    recommendations: [],
    skipped: 0,
    suggestReview: false,
  };
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
