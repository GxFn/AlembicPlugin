/**
 * PrimeSearchPipeline — Enrichment Layer
 *
 * Multi-query parallel search + scenario routing + session history accumulation.
 * Replaces TaskKnowledgeBridge with full search pipeline integration.
 *
 * @module service/task/PrimeSearchPipeline
 */

import type { SearchResultItem, SlimSearchResult } from '@alembic/core/search';
import { slimSearchResult } from '@alembic/core/search';
import {
  type ResidentIntentEvidenceSummary,
  type ResidentPrimeInjectionPackageSummary,
  type ResidentPrimeRetrievalConsumerSummary,
  type ResidentSearchAttemptMeta,
  type ResidentSearchRequest,
  type ResidentSearchResult,
  unavailablePrimeRetrievalConsumerSummary,
} from '../resident/AlembicResidentServiceClient.js';
import {
  buildResidentIntentHandoff,
  type HostIntentFrame,
  type ResidentIntentHandoff,
} from './HostIntentFrame.js';
import type { ExtractedIntent } from './IntentExtractor.js';

// ── Types ───────────────────────────────────────────

/** Slim search result (re-export for external use) */
export type { SlimSearchResult } from '@alembic/core/search';

export interface PrimeSearchMeta {
  queries: string[];
  scenario: string;
  language: string | null;
  module: string | null;
  resultCount: number;
  filteredCount: number;
  intentEvidence?: ResidentIntentEvidenceSummary;
  primeInjectionPackage?: ResidentPrimeInjectionPackageSummary;
  retrievalConsumer?: ResidentPrimeRetrievalConsumerSummary;
  residentSearch?: ResidentSearchAttemptMeta;
}

export interface PrimeSearchResult {
  relatedKnowledge: SlimSearchResult[];
  guardRules: SlimSearchResult[];
  searchMeta: PrimeSearchMeta;
}

/** Minimal SearchEngine shape — duck-typed for DI flexibility */
interface SearchEngineLike {
  search(
    query: string,
    options?: {
      mode?: string;
      limit?: number;
      rank?: boolean;
      context?: {
        sessionHistory?: Array<{ content?: string }>;
        language?: string;
        intent?: string;
      };
    }
  ): Promise<{ items?: unknown[] }>;
}

interface ResidentServiceClientLike {
  search(request: ResidentSearchRequest): Promise<ResidentSearchResult>;
}

interface PrimeSearchPipelineOptions {
  residentServiceClient?: ResidentServiceClientLike | null;
}

export interface PrimeSearchOptions {
  hostIntentFrame?: HostIntentFrame;
  projectRoot?: string;
}

// ── Constants ───────────────────────────────────────

/** Absolute minimum score — items below this are definitely noise */
const MIN_SCORE_THRESHOLD = 0.3;
/** Relative threshold — items scoring below this fraction of the best result are dropped */
const RELATIVE_SCORE_RATIO = 0.15;
/** Gap ratio — if score drops by more than this factor from the previous item, truncate */
const GAP_DROP_RATIO = 0.25;

// ── PrimeSearchPipeline ─────────────────────────────

export class PrimeSearchPipeline {
  #residentServiceClient: ResidentServiceClientLike | null;
  #search: SearchEngineLike;
  #sessionQueries: string[] = [];

  constructor(searchEngine: SearchEngineLike, options: PrimeSearchPipelineOptions = {}) {
    this.#search = searchEngine;
    this.#residentServiceClient = options.residentServiceClient ?? null;
  }

  /**
   * Core method: multi-query search + scenario routing + result merging.
   */
  async search(
    intent: ExtractedIntent,
    options: PrimeSearchOptions = {}
  ): Promise<PrimeSearchResult | null> {
    if (!intent.queries.length || !intent.queries[0]?.trim()) {
      return null;
    }

    const sessionHistory = this.#buildSessionHistory();
    const residentIntentHandoff = buildResidentIntentHandoff({
      hostIntentFrame: options.hostIntentFrame,
      language: intent.language,
      sessionHistory,
      userQuery: intent.raw.userQuery,
    });

    // Build ranking context
    const context = {
      language: residentIntentHandoff?.language ?? intent.language ?? undefined,
      intent: residentIntentHandoff?.searchIntent ?? intent.scenario,
      sessionHistory,
    };

    // Multi-query parallel search (auto mode + keyword mode for cross-language)
    const searchBundle = await this.#multiQuerySearch(
      intent.queries,
      intent.keywordQueries ?? [],
      context,
      residentIntentHandoff,
      options.projectRoot
    );
    const allResults = searchBundle.items;

    // Quality filter: absolute threshold + relative-to-best + score gap detection
    const filtered = this.#qualityFilter(allResults);

    if (filtered.length === 0) {
      if (searchBundle.residentSearch) {
        return {
          relatedKnowledge: [],
          guardRules: [],
          searchMeta: this.#buildSearchMeta(
            intent,
            allResults.length,
            0,
            searchBundle.residentSearch
          ),
        };
      }
      return null;
    }

    // Classify: knowledge vs rules
    const knowledge = filtered.filter((r) => r.kind !== 'rule').slice(0, 5);
    const rules = filtered.filter((r) => r.kind === 'rule').slice(0, 3);

    // Record search to session history
    this.#sessionQueries.push(intent.raw.userQuery);

    return {
      relatedKnowledge: knowledge,
      guardRules: rules,
      searchMeta: this.#buildSearchMeta(
        intent,
        allResults.length,
        filtered.length,
        searchBundle.residentSearch
      ),
    };
  }

  /**
   * Reset session history (called on new session start).
   */
  resetSession(): void {
    this.#sessionQueries = [];
  }

  // ── Private ───────────────────────────────────────

  /**
   * Quality filter: absolute threshold + relative-to-best + score gap detection.
   * Expects items sorted by score descending.
   */
  #qualityFilter(items: SlimSearchResult[]): SlimSearchResult[] {
    if (items.length === 0) {
      return [];
    }
    const maxScore = items[0]?.score ?? 0;
    const effectiveThreshold = Math.max(MIN_SCORE_THRESHOLD, maxScore * RELATIVE_SCORE_RATIO);

    const result: SlimSearchResult[] = [];
    let prevScore = maxScore;
    for (const item of items) {
      const score = item.score;
      if (score < effectiveThreshold) {
        break;
      }
      // Gap detection: if score drops sharply from previous item, stop
      if (result.length > 0 && score < prevScore * GAP_DROP_RATIO) {
        break;
      }
      result.push(item);
      prevScore = score;
    }
    return result;
  }

  /**
   * Multi-query parallel search with optional Reciprocal Rank Fusion (RRF).
   *
   * Single-query: preserves original search engine scores (lexical/CoarseRanker).
   * Multi-query: uses RRF to fuse results, but weights by original score to
   * retain magnitude information.
   */
  async #multiQuerySearch(
    autoQueries: string[],
    keywordQueries: string[],
    context: { language?: string; intent?: string; sessionHistory?: Array<{ content: string }> },
    residentIntentHandoff: ResidentIntentHandoff | null,
    projectRoot?: string
  ): Promise<{ items: SlimSearchResult[]; residentSearch?: ResidentSearchAttemptMeta }> {
    // Auto-mode searches (lexical without CoarseRanker ranking)
    // Using rank: false preserves raw lexical/FWS score magnitude,
    // which the quality filter needs for effective discrimination.
    // CoarseRanker's max-normalization + freshness/popularity signals
    // would cluster scores around 0.35–0.41, defeating the filter.
    const autoPromises = autoQueries.map((q) =>
      this.#search
        .search(q, { mode: 'auto', limit: 8, rank: false, context })
        .catch(() => ({ items: [] }))
    );

    // Semantic-mode search for primary query — ensures semantic is always
    // part of RRF fusion even when auto mode skips it (confidence ≥ 60)
    const semanticPromise = autoQueries[0]
      ? this.#search
          .search(autoQueries[0], { mode: 'semantic', limit: 6, rank: false })
          .catch(() => ({ items: [] }))
      : Promise.resolve({ items: [] });

    // AlembicPlugin 不再持有 embedding executor。语义增强由本地 Alembic resident service
    // 提供；不可用时保留 baseline embedded search，并把原因写入 searchMeta。
    const residentPromise = autoQueries[0]
      ? this.#residentSemanticSearch(autoQueries[0], residentIntentHandoff, projectRoot)
      : Promise.resolve(null);

    // Keyword-mode searches (raw FWS scores — for cross-language synonym matching)
    const kwPromises = keywordQueries.map((q) =>
      this.#search
        .search(q, { mode: 'keyword', limit: 8, rank: false })
        .catch(() => ({ items: [] }))
    );

    const [autoResponses, kwResponses, semanticResponse, residentResponse] = await Promise.all([
      Promise.all(autoPromises),
      Promise.all(kwPromises),
      semanticPromise,
      residentPromise,
    ]);

    // Merge: auto + semantic + keyword
    const semanticItems = ((semanticResponse as { items?: unknown[] }).items ||
      []) as SearchResultItem[];
    const allResponses = [
      ...autoResponses,
      ...(semanticItems.length > 0 ? [semanticResponse] : []),
      ...(residentResponse?.items.length ? [residentResponse] : []),
      ...kwResponses,
    ];
    const residentSearch = residentResponse?.meta;

    // Single-query shortcut: preserve original scores from search engine.
    // RRF is pointless with one response — it just converts rank to score,
    // discarding the magnitude information from lexical/CoarseRanker.
    if (allResponses.length === 1) {
      const items = (allResponses[0]?.items || []) as SearchResultItem[];
      return {
        items: items.map(slimSearchResult).sort((a, b) => b.score - a.score),
        ...(residentSearch ? { residentSearch } : {}),
      };
    }

    // Multi-query: Weighted RRF — RRF(d) = Σ origScore / (k + rank)
    // Retains original score magnitude while still boosting cross-query overlap.
    const RRF_K = 60;
    const rrfScores = new Map<string, number>();
    const itemById = new Map<string, SlimSearchResult>();

    for (const resp of allResponses) {
      const items = (resp.items || []) as SearchResultItem[];
      for (let rank = 0; rank < items.length; rank++) {
        const raw = items[rank] as SearchResultItem;
        const origScore = Math.max((raw.score as number) || 0, 0.01);
        const item = slimSearchResult(raw);
        rrfScores.set(item.id, (rrfScores.get(item.id) ?? 0) + origScore / (RRF_K + rank));
        // Keep the richest metadata version
        if (!itemById.has(item.id)) {
          itemById.set(item.id, item);
        }
      }
    }

    // Assign fused scores and sort
    // Rescale: RRF_K division crushes scores to ~0.003–0.02 range,
    // which falls below qualityFilter's MIN_SCORE_THRESHOLD (0.1).
    // Multiply by RRF_K to restore original score magnitude.
    // Effective formula: Σ origScore / (1 + rank/K), preserving magnitude
    // while still giving a gentle rank-based discount.
    const results: SlimSearchResult[] = [];
    for (const [id, rrfScore] of rrfScores) {
      const item = itemById.get(id);
      if (!item) {
        continue;
      }
      item.score = Math.round(rrfScore * RRF_K * 1000) / 1000;
      results.push(item);
    }
    return {
      items: results.sort((a, b) => b.score - a.score),
      ...(residentSearch ? { residentSearch } : {}),
    };
  }

  async #residentSemanticSearch(
    query: string,
    residentIntentHandoff: ResidentIntentHandoff | null,
    projectRoot?: string
  ): Promise<ResidentSearchResult | null> {
    if (!this.#residentServiceClient) {
      return null;
    }
    try {
      return await this.#residentServiceClient.search({
        query,
        mode: 'semantic',
        limit: 6,
        rank: false,
        ...(projectRoot ? { projectRoot } : {}),
        ...(residentIntentHandoff
          ? {
              confidence: residentIntentHandoff.confidence,
              degraded: residentIntentHandoff.degraded,
              degradedReason: residentIntentHandoff.degradedReason,
              hostDeclaredIntent: residentIntentHandoff.hostDeclaredIntent,
              hostTurnMeta: residentIntentHandoff.hostTurnMeta,
              intentContext: residentIntentHandoff.intentContext,
              language: residentIntentHandoff.language,
              scenario: residentIntentHandoff.scenario,
              searchIntent: residentIntentHandoff.searchIntent,
              sessionHistory: residentIntentHandoff.sessionHistory,
              sourceRefs: residentIntentHandoff.sourceRefs,
            }
          : {}),
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[PrimeSearchPipeline] resident semantic search unavailable: ${reason}\n`
      );
      return {
        items: [],
        meta: {
          attempted: true,
          available: false,
          durationMs: 0,
          ...(residentIntentHandoff
            ? {
                hostIntentHandoff: {
                  degraded: residentIntentHandoff.degraded,
                  degradedReasons: residentIntentHandoff.degradedReason
                    ? [residentIntentHandoff.degradedReason]
                    : [],
                  enabled: true,
                  requestRoute: 'post-body',
                  sessionHistoryCount: residentIntentHandoff.sessionHistory?.length ?? 0,
                  sourceRefsCount: residentIntentHandoff.sourceRefs?.length ?? 0,
                },
              }
            : {}),
          reason,
          requestedMode: 'semantic',
          residentVector: { available: false, reason },
          retrievalConsumer: unavailablePrimeRetrievalConsumerSummary(reason),
          resultCount: 0,
          route: 'alembic-resident-service',
          used: false,
        },
      };
    }
  }

  #buildSearchMeta(
    intent: ExtractedIntent,
    resultCount: number,
    filteredCount: number,
    residentSearch?: ResidentSearchAttemptMeta
  ): PrimeSearchMeta {
    return {
      queries: intent.queries,
      scenario: intent.scenario,
      language: intent.language,
      module: intent.module,
      resultCount,
      filteredCount,
      ...(residentSearch?.intentEvidence ? { intentEvidence: residentSearch.intentEvidence } : {}),
      ...(residentSearch?.primeInjectionPackage
        ? { primeInjectionPackage: residentSearch.primeInjectionPackage }
        : {}),
      ...(residentSearch?.retrievalConsumer
        ? { retrievalConsumer: residentSearch.retrievalConsumer }
        : {}),
      ...(residentSearch ? { residentSearch } : {}),
    };
  }

  /**
   * Build sessionHistory for contextBoost (last 5 queries).
   */
  #buildSessionHistory(): Array<{ content: string }> {
    return this.#sessionQueries.slice(-5).map((q) => ({ content: q }));
  }
}
