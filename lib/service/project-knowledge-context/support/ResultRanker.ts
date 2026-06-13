export interface RankableKnowledgeContextItem {
  id: string;
  score?: number;
  title?: string;
}

export class ResultRanker {
  rank<T extends RankableKnowledgeContextItem>(items: readonly T[]): T[] {
    return [...items].sort((left, right) => {
      const scoreDelta = (right.score ?? 0) - (left.score ?? 0);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.id.localeCompare(right.id);
    });
  }
}

export const defaultResultRanker = new ResultRanker();
