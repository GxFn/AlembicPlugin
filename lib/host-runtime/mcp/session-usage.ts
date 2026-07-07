export type McpToolUsageEntry = {
  count: number;
  lastCalledAt: number;
};

export type McpToolUsageMap = Map<string, McpToolUsageEntry>;

const TRACKED_MCP_USAGE_TOOLS = [
  ['alembic_prime', 'prime'],
  ['alembic_search', 'search'],
  ['alembic_recipe_map', 'recipeMap'],
  ['alembic_graph', 'graph'],
] as const;

type ToolUsageKey = (typeof TRACKED_MCP_USAGE_TOOLS)[number][1];

export type McpToolUsageView = {
  byTool: Record<ToolUsageKey, { count: number; lastCalledAt: number | null }>;
};

export function trackMcpToolUsage(
  toolUsage: McpToolUsageMap,
  toolName: string,
  now = Date.now()
): void {
  const previous = toolUsage.get(toolName);
  toolUsage.set(toolName, {
    count: (previous?.count ?? 0) + 1,
    lastCalledAt: now,
  });
}

export function buildMcpToolUsageView(toolUsage?: McpToolUsageMap | null): McpToolUsageView {
  const byTool = Object.fromEntries(
    TRACKED_MCP_USAGE_TOOLS.map(([toolName, key]) => {
      const usage = toolUsage?.get(toolName);
      return [
        key,
        {
          count: usage?.count ?? 0,
          lastCalledAt: usage?.lastCalledAt ?? null,
        },
      ];
    })
  ) as McpToolUsageView['byTool'];
  return { byTool };
}
