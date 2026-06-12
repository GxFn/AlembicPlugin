import { describe, expect, it } from 'vitest';

describe('Host-agent bootstrap route', () => {
  it('loads the Plugin-owned host-agent bootstrap adapter', async () => {
    const route = await import('../../lib/runtime/mcp/handlers/host-agent/bootstrap.js');

    expect(route.bootstrapForHostAgent).toBeTypeOf('function');
    expect(route.getActiveSession).toBeTypeOf('function');
  });
});
