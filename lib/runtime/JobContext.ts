export const JOB_CLIENT = 'codex-plugin';

export interface JobContextInput {
  createdByTool: string;
  sessionId: string;
  user?: string;
}

export function createJobContext(input: JobContextInput) {
  return {
    actor: {
      role: 'host-mcp',
      ...(input.user ? { user: input.user } : {}),
    },
    client: JOB_CLIENT,
    createdByTool: input.createdByTool,
    sessionId: input.sessionId,
  };
}
