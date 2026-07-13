/**
 * PrimeSearchPipeline — prime retrieval adapter (PDR-1d)
 *
 * Route-agnostic thin adapter over the unified in-process SearchEngine (the same
 * engine alembic_search uses). Takes a structured prime query, runs one
 * canonical vector/lexical search and presents the already-authoritative order
 * as knowledge vs Guard groups. The legacy intent-frame multi-query/RRF orchestration and the
 * resident-handoff lane were removed in PDR-1d; local Recipe semantic-region
 * evidence is wired separately (PDR-2) via PrimeKnowledgeMaterial's
 * `regionEvidence` seam.
 *
 * @module service/task/PrimeSearchPipeline
 */

import type { SearchResultItem, SlimSearchResult } from '@alembic/core/search';
import { slimSearchResult } from '@alembic/core/search';

// ── Types ───────────────────────────────────────────

/** Slim search result (re-export for external use) */
export type { SlimSearchResult } from '@alembic/core/search';

export interface PrimeSearchMeta {
  candidateRecipeIds: string[];
  queries: string[];
  scenario: string;
  language: string | null;
  module: string | null;
  resultCount: number;
  filteredCount: number;
  filteredOrphanVectorCount?: number;
  route: string;
  requestedMode: string;
  actualMode: string;
  semanticUsed: boolean;
  vectorUsed: boolean;
  fallbackReason?: string;
}

export interface PrimeSearchResult {
  relatedKnowledge: PrimeCandidateResult[];
  guardRules: PrimeCandidateResult[];
  searchMeta: PrimeSearchMeta;
}

/** Structured prime retrieval request (route-agnostic; derived from the prime requirement frame). */
export interface PrimeSearchRequest {
  query: string;
  queries?: string[];
  scenario?: string;
  language?: string | null;
  module?: string | null;
  limit?: number;
  filters?: Record<string, unknown>;
}

/** Minimal SearchEngine shape — duck-typed for DI flexibility */
interface SearchEngineLike {
  search(
    query: string,
    options?: { mode?: string; limit?: number; rank?: boolean; [key: string]: unknown }
  ): Promise<{ items?: unknown[]; searchMeta?: Record<string, unknown> }>;
}

// ── PrimeSearchPipeline ─────────────────────────────

export class PrimeSearchPipeline {
  #search: SearchEngineLike;

  constructor(searchEngine: SearchEngineLike) {
    this.#search = searchEngine;
  }

  /**
   * Run one unified search for the structured prime query and split the
   * canonical candidates into knowledge vs Guard presentation groups.
   */
  async search(request: PrimeSearchRequest): Promise<PrimeSearchResult | null> {
    const query = request.query?.trim();
    if (!query) {
      return null;
    }
    const limit = boundedLimit(request.limit);
    const response = await this.#search.search(query, {
      ...(request.filters ?? {}),
      mode: 'auto',
      limit,
      rank: false,
    });
    const items = ((response.items || []) as SearchResultItem[]).map(projectPrimeCandidate);
    const knowledge = items.filter((r) => r.kind !== 'rule').slice(0, limit);
    const rules = items.filter((r) => r.kind === 'rule').slice(0, limit);
    return {
      relatedKnowledge: knowledge,
      guardRules: rules,
      searchMeta: this.#buildSearchMeta(
        request,
        items.length,
        items.length,
        items.map((item) => item.id),
        response.searchMeta
      ),
    };
  }

  // ── Private ───────────────────────────────────────

  #buildSearchMeta(
    request: PrimeSearchRequest,
    resultCount: number,
    filteredCount: number,
    candidateRecipeIds: string[],
    routeMeta: Record<string, unknown> | undefined
  ): PrimeSearchMeta {
    const filteredOrphanVectorCount = boundedPositiveCount(routeMeta?.filteredOrphanVectorCount);
    return {
      candidateRecipeIds,
      queries: request.queries?.length ? request.queries : [request.query],
      scenario: request.scenario ?? '',
      language: request.language ?? null,
      module: request.module ?? null,
      resultCount,
      filteredCount,
      route: readString(routeMeta?.route) ?? 'unknown',
      requestedMode: readString(routeMeta?.requestedMode) ?? 'auto',
      actualMode: readString(routeMeta?.actualMode) ?? 'keyword',
      semanticUsed: routeMeta?.semanticUsed === true,
      vectorUsed: routeMeta?.vectorUsed === true,
      ...(filteredOrphanVectorCount === undefined ? {} : { filteredOrphanVectorCount }),
      ...(normalizePrimeFallbackReason(routeMeta?.fallbackReason)
        ? { fallbackReason: normalizePrimeFallbackReason(routeMeta?.fallbackReason) }
        : {}),
    };
  }
}

export type PrimeCandidateResult = SlimSearchResult & {
  denseRank?: number;
  denseSimilarity?: number;
  sparseRank?: number;
  sparseScore?: number;
  rrfContribution?: { dense: number; sparse: number; total: number };
  regionEvidence?: unknown[];
  retrievalDiagnostics?: Record<string, unknown>;
};

function projectPrimeCandidate(item: SearchResultItem): PrimeCandidateResult {
  const record = item as unknown as Record<string, unknown>;
  return {
    ...slimSearchResult(item),
    ...copyFiniteNumber(record, 'denseRank'),
    ...copyFiniteNumber(record, 'denseSimilarity'),
    ...copyFiniteNumber(record, 'sparseRank'),
    ...copyFiniteNumber(record, 'sparseScore'),
    ...(isRecord(record.rrfContribution)
      ? { rrfContribution: record.rrfContribution as PrimeCandidateResult['rrfContribution'] }
      : {}),
    ...(Array.isArray(record.regionEvidence) ? { regionEvidence: record.regionEvidence } : {}),
    ...(isRecord(record.retrievalDiagnostics)
      ? { retrievalDiagnostics: record.retrievalDiagnostics }
      : {}),
  };
}

function boundedLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(100, value)
    : 10;
}

function copyFiniteNumber(value: Record<string, unknown>, key: string): Record<string, number> {
  return typeof value[key] === 'number' && Number.isFinite(value[key]) ? { [key]: value[key] } : {};
}

function boundedPositiveCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(10_000, Math.floor(value))
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizePrimeFallbackReason(value: unknown): string | undefined {
  const reason = readString(value)?.toLowerCase();
  if (!reason) {
    return undefined;
  }
  if (reason.startsWith('vector_store_query_failed')) {
    return 'vector-store-query-failed';
  }
  if (reason.startsWith('semantic_search_failed')) {
    return 'semantic-search-failed';
  }
  if (reason.includes('vector_store_unavailable')) {
    return 'vector-store-unavailable-or-empty';
  }
  if (reason.includes('embed_provider_unavailable')) {
    return 'embed-provider-unavailable';
  }
  if (reason.includes('empty_query_embedding')) {
    return 'empty-query-embedding';
  }
  if (/^[a-z0-9_-]+$/.test(reason)) {
    return reason.replaceAll('_', '-');
  }
  return 'search-route-unavailable';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
