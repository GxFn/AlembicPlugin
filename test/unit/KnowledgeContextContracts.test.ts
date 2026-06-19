import { describe, expect, test } from 'vitest';
import '../../lib/runtime/mcp/knowledge-context-tools/graph-output.js';
import { KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES } from '../../lib/runtime/mcp/knowledge-context-tools/output.js';
import { getMcpOutputProjector } from '../../lib/runtime/mcp/output-contract.js';
import {
  KNOWLEDGE_CONTEXT_AGENT_HOSTS,
  KnowledgeContextBaseInputSchema,
  KnowledgeSearchInputSchema,
  ProjectGraphInputSchema,
} from '../../lib/service/project-knowledge-context/contracts/index.js';

// GMAP-8c: the KnowledgeContextToolOutput envelope, the ProjectMatrix input schema,
// and the middle layer are retired. The four tools each own their public output
// (AlembicGraphOutput / AlembicRecipeMapOutput / AlembicSearchOutput / AgentPrimeOutput,
// covered by their own tests). What remains here is the shared input-contract surface
// (base/graph/search input) and the now-empty shared clean-output set.
describe('Project knowledge context input contracts (post middle-layer retirement)', () => {
  test('parses host-neutral base input without defaulting to a specific agent host', () => {
    const parsed = KnowledgeContextBaseInputSchema.parse({
      query: 'What project knowledge should guide this change?',
      inputSource: 'user-message',
      intentKind: 'implementation-task',
    });

    expect(parsed.agentHost).toBeUndefined();
    expect(KNOWLEDGE_CONTEXT_AGENT_HOSTS).toEqual(['codex', 'claude-code']);
  });

  test('parses valid inputs for the live knowledge-context input tools', () => {
    expect(
      KnowledgeSearchInputSchema.parse({
        operation: 'get',
        mode: 'semantic',
        refId: 'knowledge:contract-boundary',
        kind: 'guide',
      })
    ).toMatchObject({ operation: 'get', kind: 'guide' });

    for (const mode of ['auto', 'keyword', 'semantic']) {
      expect(KnowledgeSearchInputSchema.safeParse({ query: 'x', mode }).success).toBe(true);
    }
    expect(
      KnowledgeSearchInputSchema.safeParse({ query: 'x', mode: 'unsupported-mode' }).success
    ).toBe(false);

    expect(
      ProjectGraphInputSchema.parse({
        operation: 'neighborhood',
        nodeId: 'file:lib/service/project.ts',
        nodeType: 'file',
        relationType: 'ownsFile',
        maxDepth: 3,
      })
    ).toMatchObject({ operation: 'neighborhood', nodeType: 'file', relationType: 'ownsFile' });
  });

  test('rejects lifecycle operations from the knowledge-context input surface', () => {
    expect(KnowledgeSearchInputSchema.safeParse({ operation: 'confirm_usage' }).success).toBe(
      false
    );
    expect(ProjectGraphInputSchema.safeParse({ operation: 'knowledge_lifecycle' }).success).toBe(
      false
    );
  });

  test('rejects non-project graph node types from alembic_graph input', () => {
    expect(ProjectGraphInputSchema.safeParse({ nodeType: 'recipe' }).success).toBe(false);
    expect(ProjectGraphInputSchema.safeParse({ nodeType: 'knowledge' }).success).toBe(false);
    expect(ProjectGraphInputSchema.safeParse({ nodeType: 'file' }).success).toBe(true);
  });

  test('accepts hostDeclaredIntent on alembic_graph with the shared MCP intent shape', () => {
    const parsed = ProjectGraphInputSchema.parse({
      hostDeclaredIntent: {
        action: 'review',
        confidence: 0.8,
        goal: 'Inspect project graph boundary',
        keywords: ['ProjectContext'],
        query: 'ProjectContext direct graph boundary',
        source: 'codex',
        sourceRefs: ['host:intent'],
        summary: 'Review graph direct boundary',
      },
      operation: 'query',
    });

    expect(parsed.hostDeclaredIntent?.query).toBe('ProjectContext direct graph boundary');
    expect(parsed.hostDeclaredIntent?.sourceRefs).toEqual(['host:intent']);
  });

  test('the shared KnowledgeContextToolOutput clean-output set is empty (each tool owns its output)', () => {
    // GMAP-1/4/8/8b: graph/recipe_map/search each project their own schema; prime is
    // agent-public; matrix is retired. GMAP-8c deletes the shared envelope module.
    expect(KNOWLEDGE_CONTEXT_CLEAN_OUTPUT_TOOL_NAMES).toEqual([]);
    expect(getMcpOutputProjector('alembic_graph')).toMatchObject({
      outputSchemaName: 'alembic_graph_clean_output',
      projectorName: 'alembic-graph-clean-output-projector',
    });
  });
});
