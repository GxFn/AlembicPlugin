export interface RecipeRelationChain {
  hops: string[];
  scoreImpact?: 'positive' | 'neutral-or-caution';
  relationType: string;
  source?: string;
}

export interface RecipeRelationChainProvider {
  expandRecipeRelationChains(
    refId: string,
    maxHops: number,
    options?: RecipeRelationChainOptions
  ): RecipeRelationChain[];
}

export interface RecipeRelationChainOptions {
  fanout?: number;
  items?: readonly Record<string, unknown>[];
  relationEdges?: readonly Record<string, unknown>[];
}

export class DefaultRecipeRelationChainProvider implements RecipeRelationChainProvider {
  expandRecipeRelationChains(
    refId: string,
    maxHops: number,
    options: RecipeRelationChainOptions = {}
  ): RecipeRelationChain[] {
    const fanout = Math.max(1, Math.min(options.fanout ?? 5, 20));
    const edges = dedupeEdges([
      ...collectEdgesFromItems(options.items ?? []),
      ...collectExplicitEdges(options.relationEdges ?? []),
    ]);
    const chains: RecipeRelationChain[] = [];
    const queue: Array<{ hops: string[]; relationType: string; source?: string }> = edges
      .filter((edge) => sameKnowledgeRef(edge.from, refId))
      .slice(0, fanout)
      .map((edge) => ({
        hops: [refId, edge.to],
        relationType: edge.relationType,
        source: edge.source,
      }));

    while (queue.length > 0 && chains.length < fanout) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      chains.push({
        ...current,
        scoreImpact: scoreImpactForRelation(current.relationType),
      });
      if (current.hops.length - 1 >= maxHops) {
        continue;
      }
      const last = current.hops[current.hops.length - 1];
      for (const edge of edges.filter((candidate) => sameKnowledgeRef(candidate.from, last)).slice(0, fanout)) {
        if (current.hops.some((hop) => sameKnowledgeRef(hop, edge.to))) {
          continue;
        }
        queue.push({
          hops: [...current.hops, edge.to],
          relationType: edge.relationType,
          source: edge.source,
        });
      }
    }
    return chains;
  }
}

interface RelationEdge {
  from: string;
  relationType: string;
  source?: string;
  to: string;
}

function collectEdgesFromItems(items: readonly Record<string, unknown>[]): RelationEdge[] {
  const edges: RelationEdge[] = [];
  for (const item of items) {
    const from = readString(item.id);
    if (!from) {
      continue;
    }
    edges.push(...collectRelationBucket(from, item.relations, 'relations'));
    const metadata = readRecord(item.metadata);
    edges.push(...collectRelationBucket(from, metadata?.relations, 'metadata.relations'));
    edges.push(
      ...collectRelationBucket(from, metadata?.knowledge_edges, 'metadata.knowledge_edges')
    );
    edges.push(...collectRelationBucket(from, metadata?.knowledgeEdges, 'metadata.knowledgeEdges'));
  }
  return edges;
}

function collectExplicitEdges(edges: readonly Record<string, unknown>[]): RelationEdge[] {
  return edges
    .map((edge) => {
      const from = readString(edge.from) ?? readString(edge.fromId) ?? readString(edge.itemId);
      const to =
        readString(edge.to) ??
        readString(edge.toId) ??
        readString(edge.targetId) ??
        readString(edge.relatedId);
      const relationType =
        readString(edge.relationType) ?? readString(edge.relation) ?? readString(edge.type);
      if (!from || !to || !relationType) {
        return null;
      }
      return {
        from,
        to,
        relationType,
        ...(readString(edge.source) === undefined ? {} : { source: readString(edge.source) }),
      };
    })
    .filter((edge): edge is RelationEdge => edge !== null);
}

function dedupeEdges(edges: readonly RelationEdge[]): RelationEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = [edge.from, edge.relationType, edge.to].join('\u0000');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function collectRelationBucket(from: string, bucket: unknown, source: string): RelationEdge[] {
  if (!bucket || typeof bucket !== 'object') {
    return [];
  }
  if (Array.isArray(bucket)) {
    return bucket.flatMap((entry) => collectRelationArrayEntry(from, 'related', entry, source));
  }
  return Object.entries(bucket as Record<string, unknown>).flatMap(([relationType, value]) =>
    Array.isArray(value)
      ? value.flatMap((entry) => collectRelationArrayEntry(from, relationType, entry, source))
      : collectRelationArrayEntry(from, relationType, value, source)
  );
}

function collectRelationArrayEntry(
  from: string,
  relationType: string,
  entry: unknown,
  source: string
): RelationEdge[] {
  const record = readRecord(entry);
  const to = typeof entry === 'string' ? entry : readRelationTarget(record);
  if (!to) {
    return [];
  }
  const entryRelationType =
    readString(record?.relationType) ?? readString(record?.relation) ?? readString(record?.type);
  const entrySource = readString(record?.source);
  return [{ from, relationType: entryRelationType ?? relationType, source: entrySource ?? source, to }];
}

function scoreImpactForRelation(relationType: string): 'positive' | 'neutral-or-caution' {
  return ['conflicts', 'deprecated_by', 'alternative', 'replaced_by'].includes(relationType)
    ? 'neutral-or-caution'
    : 'positive';
}

function stripKnowledgePrefix(refId: string): string {
  return refId.startsWith('knowledge:') ? refId.slice('knowledge:'.length) : refId;
}

function sameKnowledgeRef(left: string, right: string): boolean {
  return left === right || stripKnowledgePrefix(left) === stripKnowledgePrefix(right);
}

function readRelationTarget(record: Record<string, unknown> | undefined): string | undefined {
  return (
    readString(record?.target) ??
    readString(record?.targetId) ??
    readString(record?.to) ??
    readString(record?.toId) ??
    readString(record?.relatedId) ??
    readString(record?.refId) ??
    readString(record?.id)
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
