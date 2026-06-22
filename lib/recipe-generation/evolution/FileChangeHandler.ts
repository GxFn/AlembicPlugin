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
      this.#sourceRefRepo.replaceSourcePath(ref.recipeId, event.oldPath, event.path, Date.now());
      freshnessIds.add(ref.recipeId);
      report.fixed++;
      report.classificationCounts.repaired++;
      if (confidence < this.#renameAutoRepairThreshold) {
        await this.#submitUpdateProposal(entry, event.path, {
          currentCode: '',
          impactLevel: 'reference',
          matchedTokens: [],
          reason: `Low-confidence rename ${event.oldPath} -> ${event.path}; pointer repaired, content review recommended.`,
        });
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
        report.skipped++;
        continue;
      }
      this.#emitSourceModified(entry.id, event.path, impact.level, impact.score);
      if (impact.level === 'reference') {
        continue;
      }

      await this.#submitUpdateProposal(entry, event.path, {
        currentCode: '',
        impactLevel: impact.level,
        matchedTokens: impact.matchedTokens,
        reason: `Modified covered source ${event.path} changed Recipe-relevant tokens: ${impact.matchedTokens.join(', ') || 'pattern match'}.`,
      });
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
      if (activeRefs.some((active) => active.sourcePath !== event.path)) {
        this.#markSourceRefStale(ref.recipeId, event.path);
        report.skipped++;
        continue;
      }

      await this.#submitDeprecationProposal(entry, event.path);
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
    return this.#sourceRefRepo.findBySourcePath(path).filter((ref) => ref.status !== 'stale');
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
  ): Promise<void> {
    await this.#evolutionGateway?.submit({
      action: 'update',
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
      source: FILE_CHANGE_PROPOSAL_SOURCE,
    });
  }

  async #submitDeprecationProposal(entry: KnowledgeEntryLike, filePath: string): Promise<void> {
    await this.#evolutionGateway?.submit({
      action: 'deprecate',
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
      source: FILE_CHANGE_PROPOSAL_SOURCE,
    });
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
    needsReview: 0,
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

function renameConfidence(event: FileChangeEvent): number {
  const similarity = (event as FileChangeEvent & { similarity?: unknown }).similarity;
  return typeof similarity === 'number' && Number.isFinite(similarity) ? similarity : 1;
}

function moduleIdForPath(filePath: string): string | null {
  const parts = filePath.split('/').filter(Boolean);
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
