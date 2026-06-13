export const CODEX_JOB_CLIENT = 'codex-plugin';

export interface CodexJobContextInput {
  createdByTool: string;
  sessionId: string;
  user?: string;
}

export function createCodexJobContext(input: CodexJobContextInput) {
  return {
    actor: {
      role: 'host-mcp',
      ...(input.user ? { user: input.user } : {}),
    },
    client: CODEX_JOB_CLIENT,
    createdByTool: input.createdByTool,
    sessionId: input.sessionId,
  };
}
