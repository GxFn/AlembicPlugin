import { describe, expect, it } from 'vitest';

describe('Host-agent bootstrap route', () => {
  it('loads the Plugin-owned host-agent bootstrap adapter', async () => {
    const route = await import('../../lib/host-runtime/mcp/handlers/host-agent/generate.js');

    expect(route.generateForHostAgent).toBeTypeOf('function');
    expect(route.getActiveSession).toBeTypeOf('function');
  });
});
