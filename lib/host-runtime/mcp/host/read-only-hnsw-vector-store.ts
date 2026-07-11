import { BinaryPersistence, HnswIndex, ScalarQuantizer, VectorStore } from '@alembic/core/vector';

const QUANTIZE_THRESHOLD = 3000;

type VectorItem = {
  content: string;
  id: string;
  metadata: Record<string, unknown>;
  vector: number[];
};

/**
 * An immutable HNSW reader for request-scoped Search snapshots.
 *
 * The normal adapter owns persistence, WAL replay, migrations and flush timers. Search only needs
 * retrieval, so loading the copied ASVEC directly keeps the public request path unable to write or
 * reconfigure process-global path policy.
 */
export class ReadOnlyHnswVectorStore extends VectorStore {
  readonly #contents: Map<string, string>;
  readonly #dimension: number;
  readonly #index: HnswIndex;
  readonly #metadata: Map<string, Record<string, unknown>>;
  readonly #quantizer: ScalarQuantizer | null;

  constructor(indexPath: string) {
    super();
    const loaded = BinaryPersistence.load(indexPath);
    this.#dimension = loaded.dimension;
    this.#index = HnswIndex.deserialize(loaded.indexData);
    this.#metadata = loaded.metadata as Map<string, Record<string, unknown>>;
    this.#contents = loaded.contents as Map<string, string>;
    this.#quantizer = loaded.quantizerData
      ? ScalarQuantizer.deserialize(loaded.quantizerData)
      : null;
    if (this.#quantizer?.trained) {
      this.#index.setQuantizedVectors(this.#quantizer);
    }
  }

  override async init(): Promise<void> {
    // The constructor synchronously loaded the already-stable private snapshot.
  }

  override async getById(id: string): Promise<VectorItem | null> {
    const nodeIndex = this.#index.idToIndex.get(id);
    const node = nodeIndex === undefined ? null : this.#index.nodes[nodeIndex];
    if (!node && !this.#metadata.has(id) && !this.#contents.has(id)) {
      return null;
    }
    return this.#item(id, node?.vector);
  }

  override async searchVector(
    queryVector: number[],
    options: Record<string, unknown> = {}
  ): Promise<Array<{ item: VectorItem; score: number }>> {
    if (queryVector.length === 0) {
      return [];
    }
    if (queryVector.length !== this.#dimension) {
      throw new Error(
        `Read-only vector query dimension mismatch: expected ${this.#dimension}, got ${queryVector.length}.`
      );
    }

    const topK = positiveInteger(options.topK, 10);
    const minScore = typeof options.minScore === 'number' ? options.minScore : 0;
    const filter = isRecord(options.filter) ? options.filter : null;
    // A complete candidate set is bounded by the copied project index and prevents metadata
    // filtering from hiding valid matches behind unrelated HNSW neighbours.
    const candidateCount = filter ? this.#index.size : topK;
    const quantizedQuery = this.#quantizer?.trained
      ? this.#quantizer.encode(queryVector)
      : undefined;
    const matches = this.#index.searchKnn(
      queryVector,
      candidateCount,
      quantizedQuery && this.#quantizer && this.#index.size > QUANTIZE_THRESHOLD
        ? { quantizedQuery, quantizer: this.#quantizer }
        : {}
    );

    return matches
      .flatMap((match) => {
        if (!match.id) {
          return [];
        }
        const item = this.#item(match.id, this.#index.nodes[match.nodeIdx]?.vector);
        const score = 1 - match.dist;
        return score >= minScore && (!filter || matchesMetadataFilter(item.metadata, filter))
          ? [{ item, score }]
          : [];
      })
      .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
      .slice(0, topK);
  }

  override async searchByFilter(filter: Record<string, unknown>): Promise<VectorItem[]> {
    return (await this.listIds())
      .map((id) => this.#item(id, this.#nodeVector(id)))
      .filter((item) => matchesMetadataFilter(item.metadata, filter));
  }

  override async listIds(): Promise<string[]> {
    return [...this.#index.idToIndex.keys()].sort((left, right) => left.localeCompare(right));
  }

  override async getStats(): Promise<{ count: number; indexSize: number }> {
    return { count: this.#index.size, indexSize: this.#index.size };
  }

  override async upsert(): Promise<void> {
    throw new Error('Read-only HNSW snapshot does not support upsert.');
  }

  override async batchUpsert(): Promise<void> {
    throw new Error('Read-only HNSW snapshot does not support batchUpsert.');
  }

  override async remove(): Promise<void> {
    throw new Error('Read-only HNSW snapshot does not support remove.');
  }

  override async clear(): Promise<void> {
    throw new Error('Read-only HNSW snapshot does not support clear.');
  }

  #item(id: string, vector?: Float32Array | number[]): VectorItem {
    return {
      content: this.#contents.get(id) ?? '',
      id,
      metadata: this.#metadata.get(id) ?? {},
      vector: vector ? Array.from(vector) : [],
    };
  }

  #nodeVector(id: string): Float32Array | number[] | undefined {
    const nodeIndex = this.#index.idToIndex.get(id);
    return nodeIndex === undefined ? undefined : this.#index.nodes[nodeIndex]?.vector;
  }
}

const SCALAR_FILTER_KEYS = [
  'type',
  'category',
  'language',
  'module',
  'regionClass',
  'recipeId',
  'dimensionId',
  'knowledgeType',
  'kind',
  'sourceRefsBridge',
] as const;

function matchesMetadataFilter(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown>
): boolean {
  for (const key of SCALAR_FILTER_KEYS) {
    if (!valueMatchesFilter(metadata[key], filter[key])) {
      return false;
    }
  }
  if (
    filter.sourcePath &&
    !(
      typeof metadata.sourcePath === 'string' &&
      metadata.sourcePath.includes(String(filter.sourcePath))
    )
  ) {
    return false;
  }
  if (Array.isArray(filter.tags)) {
    if (
      !Array.isArray(metadata.tags) ||
      !filter.tags.some((tag) => (metadata.tags as unknown[]).includes(tag))
    ) {
      return false;
    }
  }
  return !(filter.deprecated === false && metadata.deprecated);
}

function valueMatchesFilter(metadataValue: unknown, filterValue: unknown): boolean {
  if (filterValue === undefined || filterValue === null) {
    return true;
  }
  if (Array.isArray(filterValue)) {
    return Array.isArray(metadataValue)
      ? filterValue.some((value) => metadataValue.includes(value))
      : filterValue.includes(metadataValue);
  }
  return Array.isArray(metadataValue)
    ? metadataValue.includes(filterValue)
    : metadataValue === filterValue;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
