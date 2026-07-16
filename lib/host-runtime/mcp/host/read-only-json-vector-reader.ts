import { readFileSync } from 'node:fs';
import type { VectorIndexReader } from '@alembic/core/vector';

type VectorItem = {
  content: string;
  id: string;
  metadata: Record<string, unknown>;
  vector: number[];
};

/** Immutable reader for the exact JSON store sealed into a strict publication snapshot. */
export class ReadOnlyJsonVectorReader implements VectorIndexReader {
  readonly #dimension: number;
  readonly #items: Map<string, VectorItem>;

  constructor(indexPath: string, dimension: number) {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('STRICT_PUBLICATION_VECTOR_STORE_INVALID');
    }
    this.#dimension = dimension;
    this.#items = new Map(
      parsed.map((value) => {
        const item = value as VectorItem;
        if (
          !item ||
          typeof item.id !== 'string' ||
          typeof item.content !== 'string' ||
          !Array.isArray(item.vector) ||
          item.vector.length !== dimension ||
          !item.metadata ||
          typeof item.metadata !== 'object' ||
          Array.isArray(item.metadata)
        ) {
          throw new Error('STRICT_PUBLICATION_VECTOR_ITEM_INVALID');
        }
        return [item.id, item] as const;
      })
    );
    if (this.#items.size !== parsed.length) {
      throw new Error('STRICT_PUBLICATION_VECTOR_ID_SET_MISMATCH');
    }
  }

  async getById(id: string): Promise<VectorItem | null> {
    return this.#items.get(id) ?? null;
  }

  async getStats(): Promise<{ count: number; dimension: number; indexSize: number }> {
    return { count: this.#items.size, dimension: this.#dimension, indexSize: this.#items.size };
  }

  async listIds(options: { limit?: number } = {}): Promise<string[]> {
    const ids = [...this.#items.keys()].sort((left, right) => left.localeCompare(right));
    return options.limit === undefined ? ids : ids.slice(0, Math.max(0, options.limit));
  }

  async searchVector(
    queryVector: number[],
    options: { topK?: number; filter?: unknown; minScore?: number } = {}
  ): Promise<Array<{ item: VectorItem; score: number }>> {
    if (queryVector.length !== this.#dimension) {
      throw new Error(
        `STRICT_PUBLICATION_VECTOR_QUERY_DIMENSION_MISMATCH:${this.#dimension}:${queryVector.length}`
      );
    }
    const topK = positiveInteger(options.topK, 10);
    const minScore = typeof options.minScore === 'number' ? options.minScore : 0;
    const filter = isRecord(options.filter) ? options.filter : null;
    return [...this.#items.values()]
      .filter((item) => !filter || matchesMetadataFilter(item.metadata, filter))
      .map((item) => ({ item, score: cosineSimilarity(queryVector, item.vector) }))
      .filter((hit) => hit.score >= minScore)
      .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
      .slice(0, topK);
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function matchesMetadataFilter(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown>
): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (expected === undefined || expected === null) {
      continue;
    }
    const actual = metadata[key];
    if (Array.isArray(expected)) {
      const matches = Array.isArray(actual)
        ? expected.some((value) => actual.includes(value))
        : expected.includes(actual);
      if (!matches) {
        return false;
      }
      continue;
    }
    if (Array.isArray(actual) ? !actual.includes(expected) : actual !== expected) {
      return false;
    }
  }
  return true;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
