import { type KnowledgeContextBudget, KnowledgeContextBudgetSchema } from '../contracts/index.js';

export interface KnowledgeContextBudgetLimits {
  tokenBudget?: number;
  itemLimit: number;
  detailLimit: number;
  relationHopLimit: number;
  contentCharLimit: number;
  matrixNodeLimit: number;
  nextActionLimit: number;
}

export interface BudgetedArray<T> {
  items: T[];
  limit: number;
  originalCount: number;
  truncated: boolean;
}

export interface BudgetedText {
  originalLength: number;
  text: string;
  truncated: boolean;
}

export class ContextBudgeter {
  normalize(input?: KnowledgeContextBudget): KnowledgeContextBudgetLimits {
    const parsed = KnowledgeContextBudgetSchema.parse(input ?? {});
    return {
      ...(parsed.tokenBudget === undefined ? {} : { tokenBudget: parsed.tokenBudget }),
      itemLimit: parsed.itemLimit,
      detailLimit: parsed.detailLimit,
      relationHopLimit: parsed.relationHopLimit,
      contentCharLimit: parsed.contentCharLimit,
      matrixNodeLimit: parsed.matrixNodeLimit,
      nextActionLimit: parsed.nextActionLimit,
    };
  }

  trimArray<T>(items: readonly T[] | undefined, limit: number): BudgetedArray<T> {
    const source = items ?? [];
    return {
      items: source.slice(0, limit),
      limit,
      originalCount: source.length,
      truncated: source.length > limit,
    };
  }

  trimText(text: string | undefined, limit: number): BudgetedText {
    const source = text ?? '';
    if (source.length <= limit) {
      return {
        originalLength: source.length,
        text: source,
        truncated: false,
      };
    }
    return {
      originalLength: source.length,
      text: source.slice(0, Math.max(0, limit - 1)).trimEnd(),
      truncated: true,
    };
  }
}

export const defaultContextBudgeter = new ContextBudgeter();
