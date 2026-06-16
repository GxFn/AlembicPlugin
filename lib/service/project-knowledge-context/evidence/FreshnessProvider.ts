import type {
  KnowledgeContextDiagnostic,
  KnowledgeContextSourceDomain,
  KnowledgeContextStatus,
  KnowledgeContextToolName,
} from '../contracts/index.js';
import { KNOWLEDGE_CONTEXT_SOURCE_DOMAINS } from '../contracts/index.js';

export type KnowledgeContextFreshnessState =
  | 'ready'
  | 'partial'
  | 'stale'
  | 'missing'
  | 'unavailable';

export interface KnowledgeContextDomainFreshness {
  degradedReason?: string;
  domain: KnowledgeContextSourceDomain;
  observedAt?: string;
  sourceRef?: string;
  state: KnowledgeContextFreshnessState;
}

export type KnowledgeContextFreshnessByDomain = Record<
  KnowledgeContextSourceDomain,
  KnowledgeContextDomainFreshness
>;

const TOOL_REQUIRED_DOMAINS: Record<KnowledgeContextToolName, KnowledgeContextSourceDomain[]> = {
  alembic_project_matrix: ['project', 'knowledge', 'recipeRelation', 'document'],
  alembic_search: ['knowledge'],
  alembic_graph: ['project'],
  alembic_prime: ['project', 'knowledge', 'recipeRelation', 'vector', 'document', 'runtime'],
};

export function createKnowledgeContextFreshnessByDomain(
  overrides: Partial<
    Record<KnowledgeContextSourceDomain, Partial<KnowledgeContextDomainFreshness>>
  > = {},
  observedAt = new Date().toISOString()
): KnowledgeContextFreshnessByDomain {
  return Object.fromEntries(
    KNOWLEDGE_CONTEXT_SOURCE_DOMAINS.map((domain) => {
      const override = overrides[domain] ?? {};
      return [
        domain,
        {
          domain,
          observedAt,
          state: 'ready',
          ...override,
        },
      ];
    })
  ) as KnowledgeContextFreshnessByDomain;
}

export function summarizeFreshnessForTool(
  tool: KnowledgeContextToolName,
  freshness: KnowledgeContextFreshnessByDomain
): {
  degradedDomains: KnowledgeContextDomainFreshness[];
  diagnostics: KnowledgeContextDiagnostic[];
  status: KnowledgeContextStatus;
} {
  const domains = TOOL_REQUIRED_DOMAINS[tool];
  const degradedDomains = domains
    .map((domain) => freshness[domain])
    .filter((entry) => entry.state !== 'ready');
  const diagnostics = degradedDomains.map((entry) => ({
    code: `freshness-${entry.domain}-${entry.state}`,
    domain: entry.domain,
    severity: entry.state === 'missing' || entry.state === 'unavailable' ? 'error' : 'warning',
    message:
      entry.degradedReason ??
      `Knowledge context domain ${entry.domain} is ${entry.state}; output must stay ref-based and honest.`,
    retryable: entry.state === 'stale' || entry.state === 'partial',
  })) satisfies KnowledgeContextDiagnostic[];

  if (degradedDomains.some((entry) => entry.state === 'missing' || entry.state === 'unavailable')) {
    return { degradedDomains, diagnostics, status: 'degraded' };
  }
  if (degradedDomains.some((entry) => entry.state === 'stale')) {
    return { degradedDomains, diagnostics, status: 'degraded' };
  }
  if (degradedDomains.length > 0) {
    return { degradedDomains, diagnostics, status: 'partial' };
  }
  return { degradedDomains, diagnostics, status: 'ready' };
}

export function projectFreshnessForTool(
  tool: KnowledgeContextToolName,
  freshness: KnowledgeContextFreshnessByDomain
): Partial<KnowledgeContextFreshnessByDomain> {
  const domains = TOOL_REQUIRED_DOMAINS[tool];
  return Object.fromEntries(
    domains.map((domain) => [domain, freshness[domain]])
  ) as Partial<KnowledgeContextFreshnessByDomain>;
}

export interface FreshnessProvider {
  resolveFreshness(): KnowledgeContextFreshnessByDomain;
}
