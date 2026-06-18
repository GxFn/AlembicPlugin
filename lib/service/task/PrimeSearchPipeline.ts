/**
 * PrimeSearchPipeline — prime retrieval adapter (PDR-1d)
 *
 * Route-agnostic thin adapter over the unified in-process SearchEngine (the same
 * engine alembic_search uses). Takes a structured prime query, runs one
 * vector/lexical search, applies the quality filter, and splits knowledge vs
 * Guard rules. The legacy intent-frame multi-query/RRF orchestration and the
 * resident-handoff lane were removed in PDR-1d; local Recipe semantic-region
 * evidence is wired separately (PDR-2) via PrimeKnowledgeMaterial's
 * `regionEvidence` seam.
 *
 * @module service/task/PrimeSearchPipeline
 */

import type { SearchResultItem, SlimSearchResult } from '@alembic/core/search';
import { slimSearchResult } from '@alembic/core/search';
import type {
  ResidentIntentEvidenceSummary,
  ResidentPrimeInjectionPackageSummary,
  ResidentPrimeRetrievalConsumerSummary,
  ResidentSearchAttemptMeta,
} from '../resident/AlembicResidentServiceClient.js';

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
  // Optional resident-derived evidence. The local adapter does not populate
  // these; they stay so downstream trust/diagnostics keep their null-guarded
  // reads and a later resident path can repopulate them without a contract change.
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

/** Structured prime retrieval request (route-agnostic; derived from the prime requirement frame). */
export interface PrimeSearchRequest {
  query: string;
  queries?: string[];
  scenario?: string;
  language?: string | null;
  module?: string | null;
}

/** Minimal SearchEngine shape — duck-typed for DI flexibility */
interface SearchEngineLike {
  search(
    query: string,
    options?: { mode?: string; limit?: number; rank?: boolean }
  ): Promise<{ items?: unknown[] }>;
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
  #search: SearchEngineLike;

  constructor(searchEngine: SearchEngineLike) {
    this.#search = searchEngine;
  }

  /**
   * Run one unified search for the structured prime query, quality-filter the
   * results, and split into knowledge vs Guard rules.
   */
  async search(request: PrimeSearchRequest): Promise<PrimeSearchResult | null> {
    const query = request.query?.trim();
    if (!query) {
      return null;
    }
    // rank: false preserves raw lexical/FWS score magnitude for the quality filter
    // (CoarseRanker's max-normalization would cluster scores and defeat it).
    const response = await this.#search
      .search(query, { mode: 'auto', limit: 8, rank: false })
      .catch(() => ({ items: [] }));
    const items = ((response.items || []) as SearchResultItem[])
      .map(slimSearchResult)
      .sort((a, b) => b.score - a.score);
    const filtered = this.#qualityFilter(items);
    if (filtered.length === 0) {
      return null;
    }
    const knowledge = filtered.filter((r) => r.kind !== 'rule').slice(0, 5);
    const rules = filtered.filter((r) => r.kind === 'rule').slice(0, 3);
    return {
      relatedKnowledge: knowledge,
      guardRules: rules,
      searchMeta: this.#buildSearchMeta(request, items.length, filtered.length),
    };
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

  #buildSearchMeta(
    request: PrimeSearchRequest,
    resultCount: number,
    filteredCount: number
  ): PrimeSearchMeta {
    return {
      queries: request.queries?.length ? request.queries : [request.query],
      scenario: request.scenario ?? '',
      language: request.language ?? null,
      module: request.module ?? null,
      resultCount,
      filteredCount,
    };
  }
}
