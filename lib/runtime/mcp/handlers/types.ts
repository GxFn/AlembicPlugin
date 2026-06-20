/**
 * Shared type definitions for MCP handler modules.
 * Runtime-free — only interfaces and type aliases.
 */

import type {
  BootstrapFile,
  DimensionCheckpointResult,
  IncrementalPlan,
  LoggerLike,
  SaveSnapshotParams,
} from '@alembic/core/types';
import type { HostTurnMetaInput } from '#service/task/host-turn-meta.js';

// ─── DI Container (minimal shape) ────────────────────────

export interface McpServiceContainer {
  // biome-ignore lint/suspicious/noExplicitAny: MCP handler DI 是动态服务边界，调用方在具体工具内按服务语义收窄。
  get(name: string): any;
  getServiceNames?(): string[];
  singletons?: Record<string, unknown>;
}

// ─── MCP Handler Context ─────────────────────────────────

/** MCP session tracking */
export interface McpSession {
  id: string;
  startedAt: number;
  toolCallCount: number;
  toolsUsed: Set<string>;
  lastActivityAt: number;
}

/** MCP handler context passed from McpServer / router layer */
export interface McpContext {
  container: McpServiceContainer;
  startedAt?: number;
  session?: McpSession;
  hostTurnMeta?: HostTurnMetaInput;
  [key: string]: unknown;
}

// ─── Search ──────────────────────────────────────────────

/** Common search handler args */
export interface SearchArgs {
  query?: string;
  operation?: 'search' | 'get' | 'expand' | string;
  refId?: string;
  id?: string;
  detailRefId?: string;
  keywords?: string[];
  limit?: number;
  kind?: string;
  type?: string;
  mode?: string;
  category?: string;
  language?: string;
  activeFile?: string;
  module?: string;
  sessionHistory?: unknown[];
  [key: string]: unknown;
}

/** Raw search result item before projection */
export interface SearchResultItem {
  id: string;
  title: string;
  trigger?: string;
  kind?: string;
  language?: string;
  score?: number;
  description?: string;
  doClause?: string;
  whenClause?: string;
  metadata?: { kind?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Slim search item after projection */
export interface SlimSearchItem {
  id: string;
  title: string;
  trigger: string;
  kind: string;
  language: string;
  score?: number;
  description: string;
  actionHint?: string;
}

// ─── Knowledge / Browse ──────────────────────────────────

/** Minimal shape of a knowledge entry JSON (read-only projections) */
export interface KnowledgeEntryJSON {
  id: string;
  title: string;
  trigger?: string;
  kind?: string;
  language?: string;
  category?: string;
  lifecycle?: string;
  complexity?: string;
  description?: string;
  knowledgeType?: string;
  doClause?: string;
  whenClause?: string;
  dontClause?: string;
  coreCode?: string;
  tags?: string[];
  scope?: string;
  headers?: string[];
  content?: {
    pattern?: string;
    markdown?: string;
    rationale?: string;
    steps?: unknown[];
    codeChanges?: unknown[];
    verification?: unknown;
    [key: string]: unknown;
  };
  reasoning?: {
    whyStandard?: string;
    confidence?: number;
    sources?: unknown[];
    qualitySignals?: unknown;
    alternatives?: unknown;
    [key: string]: unknown;
  };
  relations?: Record<string, unknown[]>;
  constraints?: {
    guards?: unknown[];
    sideEffects?: unknown[];
    boundaries?: unknown[];
    preconditions?: unknown[];
    [key: string]: unknown;
  };
  quality?: {
    overall?: number | null;
    completeness?: number | null;
    adaptation?: number | null;
    documentation?: number | null;
    [key: string]: unknown;
  };
  stats?: {
    adoptions?: number;
    applications?: number;
    guardHits?: number;
    views?: number;
    searchHits?: number;
    [key: string]: unknown;
  };
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  toJSON?: () => KnowledgeEntryJSON;
  [key: string]: unknown;
}

// ─── Browse handler args ─────────────────────────────────

export interface BrowseListArgs {
  kind?: string;
  language?: string;
  category?: string;
  knowledgeType?: string;
  complexity?: string;
  status?: string;
  limit?: number;
  [key: string]: unknown;
}

export interface BrowseGetArgs {
  id?: string;
  [key: string]: unknown;
}

export interface ConfirmUsageArgs {
  recipeId?: string;
  id?: string;
  usageType?: string;
  feedback?: string | null;
  [key: string]: unknown;
}

// ─── Candidate handler args ──────────────────────────────

export interface ValidateCandidateArgs {
  candidate?: Record<string, unknown>;
  strict?: boolean;
  [key: string]: unknown;
}

/** Shape of a candidate object expected by validateCandidate (input from Agent) */
export interface CandidateInput {
  title?: string;
  code?: string;
  language?: string;
  category?: string;
  knowledgeType?: string;
  complexity?: string;
  trigger?: string;
  summary?: string;
  description?: string;
  usageGuide?: string;
  rationale?: string;
  headers?: string[];
  steps?: unknown;
  codeChanges?: unknown;
  constraints?: unknown;
  reasoning?: {
    whyStandard?: string;
    sources?: unknown[];
    confidence?: number;
  };
  [key: string]: unknown;
}

export interface CheckDuplicateArgs {
  candidate?: Record<string, unknown>;
  threshold?: number;
  topK?: number;
  [key: string]: unknown;
}

// ─── Tool router handler args ───────────────────────────

export interface ToolRouterSearchArgs extends SearchArgs {
  mode?: string;
}

export interface ToolRouterKnowledgeArgs extends BrowseListArgs, BrowseGetArgs {
  operation?: string;
  recipeId?: string;
  usageType?: string;
  feedback?: string | null;
}

export interface ToolRouterGraphArgs {
  operation?: string;
  [key: string]: unknown;
}

export interface ToolRouterSkillArgs {
  operation?: string;
  name?: string;
  skillName?: string;
  [key: string]: unknown;
}

export interface SubmitKnowledgeArgs {
  title?: string;
  description?: string;
  content?: { pattern?: string; [key: string]: unknown };
  dimensionId?: string;
  knowledgeType?: string;
  skipDuplicateCheck?: boolean;
  skipConsolidation?: boolean;
  [key: string]: unknown;
}

// ─── Knowledge health stats ──────────────────────────────

export interface KnowledgeBaseStats {
  recipes: {
    total: number;
    active: number;
    rules: number;
    patterns: number;
    facts: number;
  };
  candidates: { total: number; pending: number };
  vectorIndex?: { documentCount: number };
}

// ─── Bootstrap / Incremental ─────────────────────────────

export type { BootstrapFile, IncrementalPlan, SaveSnapshotParams };

// ─── Dimension checkpoint ────────────────────────────────

export type { DimensionCheckpointResult };

// ─── Logger-like interface ───────────────────────────────

export type { LoggerLike };

// ─── Duplicate check result ──────────────────────────────

export interface DuplicateCheckResult {
  hasSimilar: boolean;
  closest?: Record<string, unknown> | null;
  note?: string;
}

// ─── ByKind grouping ─────────────────────────────────────

export interface ByKindGroup {
  rule: SlimSearchItem[];
  pattern: SlimSearchItem[];
  fact: SlimSearchItem[];
}
