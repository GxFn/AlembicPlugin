/**
 * ContextualEnricher — deterministic pass-through adapter.
 *
 * AlembicPlugin no longer executes local AI enrichment. The class remains as a
 * VectorChunkEnricher-compatible boundary so existing DI and Core vector
 * contracts can opt into a host/Core-provided enricher later.
 */

import type {
  VectorChunkData,
  VectorChunkEnricher,
  VectorDocumentInfo,
} from '@alembic/core/vector';

export type ChunkData = VectorChunkData;
export type DocumentInfo = VectorDocumentInfo;

export interface EnricherConfig {
  cacheEnabled?: boolean;
}

export class ContextualEnricher implements VectorChunkEnricher {
  constructor(_config: EnricherConfig = {}) {}

  async enrichChunks(_document: DocumentInfo, chunks: ChunkData[]): Promise<ChunkData[]> {
    return chunks;
  }

  clearCache(): void {}

  get cacheSize(): number {
    return 0;
  }
}
