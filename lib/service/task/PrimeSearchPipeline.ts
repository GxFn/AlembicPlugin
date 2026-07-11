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

/** Route-calibrated relevance floor shared by lexical, semantic, and RRF evidence. */
const MIN_SCORE_THRESHOLD = 0.45;
const RELATIVE_SCORE_RATIO = 0.5;

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
    const response = await this.#search
      .search(query, { mode: 'auto', limit: 8, rank: false })
      .catch(() => ({ items: [] }));
    const items = ((response.items || []) as SearchResultItem[])
      .map((item) => ({
        ...slimSearchResult(item),
        score: calibratePrimeSearchScore(item),
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
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
   * Quality filter over route-calibrated scores. Expects items sorted descending.
   */
  #qualityFilter(items: SlimSearchResult[]): SlimSearchResult[] {
    if (items.length === 0) {
      return [];
    }
    const maxScore = items[0]?.score ?? 0;
    const effectiveThreshold = Math.max(MIN_SCORE_THRESHOLD, maxScore * RELATIVE_SCORE_RATIO);
    const result: SlimSearchResult[] = [];
    for (const item of items) {
      const score = item.score;
      if (score < effectiveThreshold) {
        break;
      }
      result.push(item);
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

function calibratePrimeSearchScore(item: SearchResultItem): number {
  const record = item as unknown as Record<string, unknown>;
  const breakdown =
    readRecord(record.scoreBreakdown) ?? readRecord(readRecord(record.metadata)?.scoreBreakdown);
  const raw = typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : 0;
  const rrf = readNumber(breakdown?.rrfScore);
  if (rrf !== undefined) {
    return clamp01(rrf / 0.03);
  }
  const semantic =
    readNumber(breakdown?.semanticScore) ??
    readNumber(breakdown?.vectorScore) ??
    (readStringArray(breakdown?.matchRoutes).includes('semantic') ? raw : undefined);
  if (semantic !== undefined) {
    return clamp01(semantic);
  }
  return raw > 1 ? clamp01(1 - Math.exp(-raw / 2)) : clamp01(raw);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function clamp01(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(6));
}
