/**
 * host-turn-meta — MCP host turn-metadata + host-declared-intent input types.
 *
 * Extracted from the retired HostIntentFrame intake layer (PDR-1d). These are
 * the kept, non-intent-paradigm utilities: the host-declared-intent arg shape
 * and the reader that lifts host turn metadata off an MCP request `_meta`.
 */

export interface HostDeclaredIntentInput {
  query?: string;
  summary?: string;
  goal?: string;
  action?: string;
  scenario?: string;
  language?: string;
  module?: string;
  labels?: string[];
  keywords?: string[];
  sourceRefs?: string[];
  confidence?: number;
  source?: string;
  [key: string]: unknown;
}

export interface HostTurnMetaInput {
  threadId?: string;
  thread_id?: string;
  conversationId?: string;
  conversation_id?: string;
  sessionId?: string;
  session_id?: string;
  turnId?: string;
  turn_id?: string;
  messageId?: string;
  message_id?: string;
  source?: string;
  surface?: string;
  timestamp?: string;
  language?: string;
  activeFile?: string;
  filePath?: string;
  cwd?: string;
  projectRoot?: string;
  workspaceRoot?: string;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().slice(0, 1600);
    }
  }
  return undefined;
}

const HOST_TURN_META_KEYS: Array<[keyof HostTurnMetaInput, string[]]> = [
  ['threadId', ['threadId', 'thread_id', 'codexThreadId']],
  ['conversationId', ['conversationId', 'conversation_id']],
  ['sessionId', ['sessionId', 'session_id']],
  ['turnId', ['turnId', 'turn_id']],
  ['messageId', ['messageId', 'message_id']],
  ['source', ['source', 'hostSource']],
  ['surface', ['surface', 'hostSurface']],
  ['timestamp', ['timestamp', 'createdAt']],
  ['language', ['language']],
  ['activeFile', ['activeFile', 'filePath']],
  ['cwd', ['cwd']],
  ['projectRoot', ['projectRoot']],
  ['workspaceRoot', ['workspaceRoot']],
];

/** Lift host turn metadata off an MCP request `_meta` / `meta` (params or root). */
export function readHostTurnMetaFromMcpRequest(request: unknown): HostTurnMetaInput | undefined {
  const requestRecord = asRecord(request);
  const params = asRecord(requestRecord?.params);
  const meta =
    asRecord(params?._meta) ??
    asRecord(requestRecord?._meta) ??
    asRecord(params?.meta) ??
    asRecord(requestRecord?.meta);
  if (!meta) {
    return undefined;
  }
  const hostTurnMeta: HostTurnMetaInput = {};
  for (const [targetKey, sourceKeys] of HOST_TURN_META_KEYS) {
    const value = firstString(meta, sourceKeys);
    if (value) {
      hostTurnMeta[targetKey] = value;
    }
  }
  return Object.keys(hostTurnMeta).length > 0 ? hostTurnMeta : undefined;
}
