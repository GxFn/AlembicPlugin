import { z } from 'zod';

export const KNOWLEDGE_CONTEXT_CONTRACT_VERSION = 1 as const;

export const KNOWLEDGE_CONTEXT_TOOL_NAMES = [
  'alembic_project_matrix',
  'alembic_prime',
  'alembic_search',
  'alembic_graph',
] as const;

export const KNOWLEDGE_CONTEXT_STATUSES = [
  'ready',
  'partial',
  'degraded',
  'blocked',
  'failed',
] as const;

export const KNOWLEDGE_CONTEXT_SOURCE_DOMAINS = [
  'project',
  'knowledge',
  'recipeRelation',
  'vector',
  'document',
  'runtime',
] as const;

export const KNOWLEDGE_CONTEXT_AGENT_HOSTS = [
  'codex',
  'claude-code',
  'generic-host-agent',
  'desktop-host-agent',
  'terminal-host-agent',
  'automation-host-agent',
] as const;

export const KNOWLEDGE_CONTEXT_INPUT_SOURCES = [
  'host-declared-intent',
  'host-turn-metadata',
  'user-message',
  'automation-envelope',
  'source-ref',
  'tool-result',
] as const;

export const KNOWLEDGE_CONTEXT_INTENT_KINDS = [
  'implementation-task',
  'fix-task',
  'refactor-task',
  'review-task',
  'read-only-analysis',
  'status-only',
  'decision',
  'design-or-planning',
  'mechanical-envelope',
  'unknown',
] as const;

export const KNOWLEDGE_CONTEXT_DETAIL_LEVELS = ['summary', 'standard', 'detailed'] as const;

export const KNOWLEDGE_CONTEXT_FRESHNESS_POLICIES = [
  'preferFresh',
  'allowStale',
  'requireFresh',
  'snapshotOnly',
] as const;

export const KnowledgeContextToolNameSchema = z.enum(KNOWLEDGE_CONTEXT_TOOL_NAMES);
export const KnowledgeContextStatusSchema = z.enum(KNOWLEDGE_CONTEXT_STATUSES);
export const KnowledgeContextSourceDomainSchema = z.enum(KNOWLEDGE_CONTEXT_SOURCE_DOMAINS);
export const KnowledgeContextAgentHostSchema = z.enum(KNOWLEDGE_CONTEXT_AGENT_HOSTS);
export const KnowledgeContextInputSourceSchema = z.enum(KNOWLEDGE_CONTEXT_INPUT_SOURCES);
export const KnowledgeContextIntentKindSchema = z.enum(KNOWLEDGE_CONTEXT_INTENT_KINDS);
export const KnowledgeContextDetailLevelSchema = z.enum(KNOWLEDGE_CONTEXT_DETAIL_LEVELS);
export const KnowledgeContextFreshnessPolicySchema = z.enum(KNOWLEDGE_CONTEXT_FRESHNESS_POLICIES);

export type KnowledgeContextToolName = z.infer<typeof KnowledgeContextToolNameSchema>;
export type KnowledgeContextStatus = z.infer<typeof KnowledgeContextStatusSchema>;
export type KnowledgeContextSourceDomain = z.infer<typeof KnowledgeContextSourceDomainSchema>;
export type KnowledgeContextAgentHost = z.infer<typeof KnowledgeContextAgentHostSchema>;
export type KnowledgeContextInputSource = z.infer<typeof KnowledgeContextInputSourceSchema>;
export type KnowledgeContextIntentKind = z.infer<typeof KnowledgeContextIntentKindSchema>;
export type KnowledgeContextDetailLevel = z.infer<typeof KnowledgeContextDetailLevelSchema>;
export type KnowledgeContextFreshnessPolicy = z.infer<typeof KnowledgeContextFreshnessPolicySchema>;
