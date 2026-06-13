/**
 * QD2 — tool-schema honesty (negative tests).
 *
 * Two tightenings proven here:
 *   1. Routed tool input schemas reject unknown top-level keys (strict) with a
 *      structured VALIDATION_ERROR — malformed input no longer silently
 *      stripped (CODE-GUARD-SCHEMA-LOOSENESS).
 *   2. Source-graph tools reject type-mismatched args (e.g. limit:"ten") with a
 *      taxonomy problem + next action instead of coercing/dropping (F-V2-1).
 *
 * Behavior guard: every correctly-typed / documented input still parses; only
 * genuinely-malformed input newly rejects.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { z } from 'zod';
import { CodexMcpServer } from '../../lib/runtime/mcp/CodexMcpServer.js';
import { findSourceGraphArgTypeIssues } from '../../lib/runtime/mcp/source-graph/status.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

let projectRoots: string[] = [];

afterEach(() => {
  for (const root of projectRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  projectRoots = [];
});

function createProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'qd2-schema-honesty-'));
  writeFileSync(join(projectRoot, 'package.json'), '{"name":"qd2","type":"module"}\n');
  writeFileSync(join(projectRoot, 'index.ts'), 'export function greet(n: string) { return n; }\n');
  projectRoots.push(projectRoot);
  return projectRoot;
}

describe('QD2 routed tool schemas reject unknown top-level keys', () => {
  test('every routed TOOL_SCHEMAS object rejects an unrecognized key', () => {
    for (const [toolName, schema] of Object.entries(TOOL_SCHEMAS)) {
      const parsed = (schema as z.ZodType).safeParse({ __qd2_unknown_key__: 1 });
      expect(parsed.success, `${toolName} must reject unknown keys`).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys'),
          `${toolName} must flag the unrecognized key`
        ).toBe(true);
      }
    }
  });

  test('a documented field-only input still parses (strict does not reject valid keys)', () => {
    // code_guard is the named CODE-GUARD-SCHEMA-LOOSENESS instance; a documented
    // field-set must still parse byte-identically under strict.
    const codeGuard = TOOL_SCHEMAS.alembic_code_guard as z.ZodType;
    const valid = codeGuard.safeParse({ userQuery: 'review this change', agentHost: 'codex' });
    expect(valid.success).toBe(true);

    // health takes no args; {} stays valid.
    expect((TOOL_SCHEMAS.alembic_health as z.ZodType).safeParse({}).success).toBe(true);
  });
});

describe('QD2 / F-V2-1 source-graph arg type honesty', () => {
  test('findSourceGraphArgTypeIssues flags present-but-wrong-typed fields only', () => {
    // The exact F-V2-1 case: limit as a string.
    expect(findSourceGraphArgTypeIssues({ query: 'greet', limit: 'ten' })).toEqual([
      'limit (expected number, received string)',
    ]);
    // Other typed fields.
    expect(findSourceGraphArgTypeIssues({ includeEdges: 'yes' })).toEqual([
      'includeEdges (expected boolean, received string)',
    ]);
    expect(findSourceGraphArgTypeIssues({ changedFiles: 'a.ts' })).toEqual([
      'changedFiles (expected array of strings, received string)',
    ]);
    // Correctly-typed and omitted values are accepted.
    expect(findSourceGraphArgTypeIssues({ query: 'greet', limit: 5 })).toEqual([]);
    expect(findSourceGraphArgTypeIssues({ query: 'greet' })).toEqual([]);
    expect(findSourceGraphArgTypeIssues({ limit: undefined, includeEdges: null })).toEqual([]);
    expect(findSourceGraphArgTypeIssues({})).toEqual([]);
    // Non-finite numbers are not honest numbers.
    expect(findSourceGraphArgTypeIssues({ limit: Number.NaN })).toEqual([
      'limit (expected number, received number)',
    ]);
  });

  test('alembic_symbol_search rejects limit:"ten" over the server with VALIDATION_ERROR', async () => {
    const projectRoot = createProject();
    const server = new CodexMcpServer({ projectRoot });
    const result = (await server.handleToolCall('alembic_symbol_search', {
      query: 'greet',
      limit: 'ten',
    })) as {
      content?: unknown;
      isError?: boolean;
      structuredContent?: { ok?: boolean; toolName?: string; error?: { code?: string } };
    };

    // Returned as an McpCallToolResult so the success projector cannot reshape it.
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.ok).toBe(false);
    expect(result.structuredContent?.toolName).toBe('alembic_symbol_search');
    expect(result.structuredContent?.error?.code).toBe('VALIDATION_ERROR');
  });

  test('alembic_symbol_search with a correctly-typed limit is not a validation error', async () => {
    const projectRoot = createProject();
    const server = new CodexMcpServer({ projectRoot });
    const result = (await server.handleToolCall('alembic_symbol_search', {
      query: 'greet',
      limit: 5,
    })) as { structuredContent?: { error?: { code?: string } } } & Record<string, unknown>;

    // It may be cold-gated/partial, but it must NOT be the malformed-arg rejection.
    const code = (result?.structuredContent as { error?: { code?: string } })?.error?.code;
    expect(code).not.toBe('VALIDATION_ERROR');
  });
});
