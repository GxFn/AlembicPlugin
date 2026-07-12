import { LOCAL_TOOLS, PROJECT_ROOT_PROPERTY } from './local-tool-catalog.js';
import '../local-tools/output.js';
import { withMcpOutputSchema } from '../output-contract.js';
import { TOOLS, withMcpToolAnnotations } from '../tools.js';

/** Public MCP tools are a static ordinary catalog. Runtime/knowledge state affects
 * each tool's truthful result, never whether the tool can be discovered or called. */
export function getVisibleTools(..._ignoredLegacyPolicyArguments: unknown[]) {
  const toolsByName = new Map([...LOCAL_TOOLS, ...TOOLS].map((tool) => [tool.name, tool] as const));
  return [...toolsByName.values()]
    .map(withMcpToolAnnotations)
    .map(withMcpOutputSchema)
    .map(withProjectRootInput);
}

function withProjectRootInput<T extends { inputSchema?: Record<string, unknown> }>(tool: T): T {
  const inputSchema = tool.inputSchema || {};
  const properties =
    inputSchema.properties && typeof inputSchema.properties === 'object'
      ? (inputSchema.properties as Record<string, unknown>)
      : {};
  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PROPERTY,
        ...properties,
      },
    },
  };
}
