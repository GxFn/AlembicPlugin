/**
 * Knowledge-context clean-output projector registry.
 *
 * GMAP-1/4/8/8b: every former knowledge-context tool now owns its public output —
 * alembic_graph (graph-output.ts), alembic_recipe_map (recipe-map-output.ts), and
 * alembic_search (search-output.ts) each project their own schema; alembic_prime is
 * an agent-public tool; alembic_project_matrix is retired. No agent tool uses the
 * shared KnowledgeContextToolOutput clean-output projector anymore, so this set is
 * empty. (The KnowledgeContextToolOutput contract module itself is retired in GMAP-8c.)
 */
export const KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES = [] as const;

export type KnowledgeContextCleanOutputToolName =
  (typeof KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES)[number];
