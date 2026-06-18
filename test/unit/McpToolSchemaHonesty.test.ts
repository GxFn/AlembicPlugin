/**
 * QD2 — tool-schema honesty (negative tests).
 *
 * Two tightenings proven here:
 *   1. Routed tool input schemas reject unknown top-level keys (strict) with a
 *      structured VALIDATION_ERROR — malformed input no longer silently
 *      stripped (CODE-GUARD-SCHEMA-LOOSENESS).
 *   2. Retired source-graph tools do not remain reachable through the routed
 *      public schema/server surface.
 *
 * Behavior guard: every correctly-typed / documented input still parses; only
 * genuinely-malformed input newly rejects.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { z } from 'zod';
import { HostMcpServer } from '../../lib/runtime/mcp/HostMcpServer.js';
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
    expect((TOOL_SCHEMAS.alembic_status as z.ZodType).safeParse({}).success).toBe(true);
  });
});

describe('QD2 / PCI-2 retired source-graph public-surface honesty', () => {
  test('source graph operation names are not routed TOOL_SCHEMAS entries', () => {
    expect(TOOL_SCHEMAS).not.toHaveProperty('alembic_source_graph_status');
    expect(TOOL_SCHEMAS).not.toHaveProperty('alembic_symbol_search');
    expect(TOOL_SCHEMAS).not.toHaveProperty('alembic_code_explore');
    expect(TOOL_SCHEMAS).not.toHaveProperty('alembic_validation_plan');
  });

  test('alembic_symbol_search fails as an unknown public tool over the server', async () => {
    const projectRoot = createProject();
    const server = new HostMcpServer({ projectRoot });
    const result = (await server.handleToolCall('alembic_symbol_search', {
      query: 'greet',
      limit: 'ten',
    })) as {
      data?: { errorCode?: string };
      errorCode?: string;
      message?: string;
      success?: boolean;
      tool?: string;
    };

    expect(result.success).toBe(false);
    expect(result.tool).toBe('alembic_symbol_search');
    expect(result.data?.errorCode).toBe('CODEX_UNKNOWN_TOOL');
    expect(result.message).toContain('Unknown Alembic tool');
  });
});
