import type {
  KnowledgeContextBudget,
  KnowledgeContextDetailRef,
  KnowledgeContextFreshness,
  KnowledgeContextSourceDomain,
  KnowledgeContextToolName,
} from '../contracts/index.js';

export interface CreateKnowledgeContextDetailRefInput {
  budget?: Partial<KnowledgeContextBudget>;
  domain: KnowledgeContextSourceDomain;
  freshness?: KnowledgeContextFreshness;
  id: string;
  operation: string;
  requiredForCompletion?: boolean;
  summary: string;
  title?: string;
  tool?: KnowledgeContextToolName;
  uri?: string;
}

export class RefRegistry {
  createDetailRef(input: CreateKnowledgeContextDetailRefInput): KnowledgeContextDetailRef {
    const id = `${input.domain}:${input.operation}:${stableRefSegment(input.id)}`.slice(0, 240);
    return {
      id,
      domain: input.domain,
      operation: input.operation,
      summary: input.summary,
      ...(input.tool === undefined ? {} : { tool: input.tool }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.uri === undefined ? {} : { uri: input.uri }),
      ...(input.freshness === undefined ? {} : { freshness: input.freshness }),
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      requiredForCompletion: input.requiredForCompletion ?? false,
    };
  }
}

export function stableRefSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_./-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 160);
}

export const defaultRefRegistry = new RefRegistry();
