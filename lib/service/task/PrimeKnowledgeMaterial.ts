import type { PrimeSearchResult, SlimSearchResult } from './PrimeSearchPipeline.js';

export type PrimeKnowledgeMaterialStatus = 'delivered' | 'empty' | 'degraded';

export interface PrimeEvidenceRef {
  path: string;
  line: number | null;
  endLine?: number | null;
}

export interface PrimeUsefulSlice {
  evidenceRefs: PrimeEvidenceRef[];
  regionClass?: string;
  score?: number;
  sourceRefsBridge?: string;
  text: string;
}

export interface AcceptedPrimeKnowledge {
  id: string;
  kind: string;
  title: string;
  trigger: string;
  actionHint?: string;
  summary: string;
  score: number;
  evidenceRefs: PrimeEvidenceRef[];
  matchedRegionClasses: string[];
  usefulSlices: PrimeUsefulSlice[];
}

export interface AcceptedPrimeGuard extends AcceptedPrimeKnowledge {}

export interface PrimeKnowledgeMaterialDegradedReason {
  code: 'search-unavailable';
  message: string;
}

export interface PrimeKnowledgeMaterial {
  status: PrimeKnowledgeMaterialStatus;
  degradedReason?: PrimeKnowledgeMaterialDegradedReason;
  intent: {
    userQuery: string;
    activeFile?: string;
    language?: string;
    module?: string;
    scenario: string;
    queries: string[];
  };
  acceptedKnowledge: AcceptedPrimeKnowledge[];
  acceptedGuards: AcceptedPrimeGuard[];
  nextActions: Array<{
    tool: string;
    args: Record<string, unknown>;
    reason: string;
    required: boolean;
  }>;
}

interface PrimeKnowledgeMaterialInput {
  requirement: {
    userQuery: string;
    activeFile?: string;
    scenario?: string;
    queries: string[];
    language?: string | null;
    module?: string | null;
    [key: string]: unknown;
  };
  searchDegraded: boolean;
  searchResult: PrimeSearchResult | null;
  sourceRefs?: string[];
  regionEvidence?: Record<string, unknown>[];
}

/** Present every local matching result. Prime no longer admits/suppresses material
 * based on intent class, score floors, producer receipts, or host readiness. */
export function buildPrimeKnowledgeMaterial(
  input: PrimeKnowledgeMaterialInput
): PrimeKnowledgeMaterial {
  const acceptedKnowledge = (input.searchResult?.relatedKnowledge ?? []).map(projectItem);
  const acceptedGuards = (input.searchResult?.guardRules ?? []).map(projectItem);
  const status: PrimeKnowledgeMaterialStatus = input.searchDegraded
    ? 'degraded'
    : acceptedKnowledge.length + acceptedGuards.length > 0
      ? 'delivered'
      : 'empty';
  const degradedReason = input.searchDegraded
    ? {
        code: 'search-unavailable' as const,
        message: 'Local knowledge search was unavailable for this request.',
      }
    : undefined;
  return {
    status,
    ...(degradedReason ? { degradedReason } : {}),
    intent: {
      userQuery: input.requirement.userQuery,
      ...(input.requirement.activeFile ? { activeFile: input.requirement.activeFile } : {}),
      ...(input.requirement.language ? { language: input.requirement.language } : {}),
      ...(input.requirement.module ? { module: input.requirement.module } : {}),
      scenario: input.requirement.scenario ?? '',
      queries: input.requirement.queries,
    },
    acceptedKnowledge,
    acceptedGuards,
    nextActions: [],
  };
}

function projectItem(item: SlimSearchResult): AcceptedPrimeKnowledge {
  const record = item as unknown as Record<string, unknown>;
  const refs = readStringArray(record.sourceRefs ?? record.sources ?? record.sourceFile).map(
    parseEvidenceRef
  );
  return {
    id: String(record.id ?? 'unknown'),
    kind: String(record.kind ?? 'knowledge'),
    title: String(record.title ?? record.id ?? 'Untitled knowledge'),
    trigger: typeof record.trigger === 'string' ? record.trigger : '',
    ...(typeof record.actionHint === 'string' ? { actionHint: record.actionHint } : {}),
    summary:
      typeof record.description === 'string'
        ? record.description
        : typeof record.summary === 'string'
          ? record.summary
          : String(record.title ?? record.id ?? ''),
    score: typeof record.score === 'number' ? record.score : 0,
    evidenceRefs: refs,
    matchedRegionClasses: [],
    usefulSlices: [],
  };
}

function readStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function parseEvidenceRef(value: string): PrimeEvidenceRef {
  const match = /^(.*?):(\d+)(?:-(\d+))?$/.exec(value);
  return match
    ? {
        path: match[1] ?? value,
        line: Number(match[2]),
        ...(match[3] ? { endLine: Number(match[3]) } : {}),
      }
    : { path: value, line: null };
}
