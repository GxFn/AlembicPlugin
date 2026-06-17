/**
 * alembic_panorama MCP Handler — retired project-information route tests.
 */
import { describe, expect, it } from 'vitest';
import { panoramaHandler } from '../../lib/runtime/mcp/handlers/panorama.js';

function makeCtx(services: Record<string, unknown> = {}) {
  return {
    container: {
      get(name: string) {
        return services[name];
      },
    },
  };
}

describe('alembic_panorama', () => {
  it.each([
    'overview',
    'module',
    'gaps',
    'health',
  ])('returns a retired response for project-information operation %s', async (operation) => {
    const result = (await panoramaHandler(makeCtx(), {
      module: 'Core',
      operation,
    })) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.message).toContain('retired');
    expect(result.data).toMatchObject({
      operation,
      replacementTools: ['alembic_recipe_map', 'alembic_graph'],
      retired: true,
    });
    expect(result.meta).toMatchObject({ tool: 'alembic_panorama' });
  });

  it('defaults to retired overview when no operation is provided', async () => {
    const result = (await panoramaHandler(makeCtx(), {})) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      operation: 'overview',
      retired: true,
    });
  });

  it('keeps governance operations independent from retired project information', async () => {
    const result = (await panoramaHandler(makeCtx(), {
      operation: 'decay_report',
    })) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.message).toContain('Decay detector not initialized');
    expect(result.meta).toMatchObject({ tool: 'alembic_panorama' });
  });

  it('throws on unknown operation', async () => {
    await expect(panoramaHandler(makeCtx(), { operation: 'unknown' })).rejects.toThrow(
      'Unknown panorama operation'
    );
  });
});
