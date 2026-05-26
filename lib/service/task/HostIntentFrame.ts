/**
 * HostIntentFrame — Codex host intent intake boundary.
 *
 * 这里是 Plugin-owned 的宿主意图承载层，只做输入归一化、敏感字段脱敏和
 * IntentExtractor 结果合并；不下沉到 Core，也不创建持久化 IntentEpisode。
 */

import { createHash } from 'node:crypto';
import type { ExtractedIntent } from './IntentExtractor.js';

export type HostIntentFrameSource = 'deterministic' | 'host-declared' | 'mixed';

export interface HostDeclaredIntentInput {
  query?: string;
  summary?: string;
  goal?: string;
  action?: string;
  scenario?: string;
  language?: string;
  module?: string;
  labels?: string[];
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

export interface NormalizedHostDeclaredIntent {
  query?: string;
  summary?: string;
  goal?: string;
  action?: string;
  scenario?: string;
  language?: string;
  module?: string;
  labels?: string[];
  confidence?: number;
  source?: string;
  [key: string]: unknown;
}

export interface NormalizedHostTurnMeta {
  turnId?: string;
  messageId?: string;
  source?: string;
  surface?: string;
  timestamp?: string;
  language?: string;
  threadIdHash?: string;
  conversationIdHash?: string;
  sessionIdHash?: string;
  redactions: string[];
  [key: string]: unknown;
}

export interface NormalizedHostIntentInput {
  userQuery: string;
  activeFile?: string;
  language?: string;
  hostDeclaredIntent?: NormalizedHostDeclaredIntent;
  hostTurnMeta?: NormalizedHostTurnMeta;
  source: HostIntentFrameSource;
  degraded: boolean;
  degradedReasons: string[];
}

export interface HostIntentFrame {
  source: HostIntentFrameSource;
  confidence: number;
  degraded: boolean;
  degradedReasons: string[];
  hostDeclaredIntent?: NormalizedHostDeclaredIntent;
  hostTurnMeta?: NormalizedHostTurnMeta;
  extracted: {
    scenario: string;
    language: string | null;
    module: string | null;
    queries: string[];
  };
}

export function prepareHostIntentInput(input: {
  userQuery?: unknown;
  activeFile?: unknown;
  language?: unknown;
  hostDeclaredIntent?: unknown;
  hostTurnMeta?: unknown;
  requestHostTurnMeta?: unknown;
}): NormalizedHostIntentInput {
  const degradedReasons: string[] = [];
  const userQuery = normalizeString(input.userQuery, 1200);
  const activeFile = normalizeString(input.activeFile, 1200);
  const language = normalizeString(input.language, 80);
  const declaredResult = normalizeHostDeclaredIntent(input.hostDeclaredIntent);
  const explicitTurnMeta = normalizeHostTurnMeta(input.hostTurnMeta);
  const requestTurnMeta = normalizeHostTurnMeta(input.requestHostTurnMeta);
  degradedReasons.push(...declaredResult.degradedReasons);
  degradedReasons.push(...explicitTurnMeta.degradedReasons);
  degradedReasons.push(...requestTurnMeta.degradedReasons);

  const hostDeclaredIntent = declaredResult.value;
  const hostTurnMeta = mergeHostTurnMeta(requestTurnMeta.value, explicitTurnMeta.value);
  const declaredQuery = firstDefinedString(
    hostDeclaredIntent?.query,
    hostDeclaredIntent?.summary,
    hostDeclaredIntent?.goal,
    hostDeclaredIntent?.action
  );
  const effectiveUserQuery = userQuery ?? declaredQuery ?? '';
  const effectiveLanguage = language ?? hostDeclaredIntent?.language ?? hostTurnMeta?.language;
  const source = resolveSource(Boolean(userQuery), Boolean(declaredQuery || hostDeclaredIntent));

  return {
    userQuery: effectiveUserQuery,
    ...(activeFile ? { activeFile } : {}),
    ...(effectiveLanguage ? { language: effectiveLanguage } : {}),
    ...(hostDeclaredIntent ? { hostDeclaredIntent } : {}),
    ...(hostTurnMeta ? { hostTurnMeta } : {}),
    source,
    degraded: degradedReasons.length > 0,
    degradedReasons,
  };
}

export function buildHostIntentFrame(
  input: NormalizedHostIntentInput,
  extracted: ExtractedIntent
): HostIntentFrame {
  return {
    source: input.source,
    confidence: resolveConfidence(input),
    degraded: input.degraded,
    degradedReasons: input.degradedReasons,
    ...(input.hostDeclaredIntent ? { hostDeclaredIntent: input.hostDeclaredIntent } : {}),
    ...(input.hostTurnMeta ? { hostTurnMeta: input.hostTurnMeta } : {}),
    extracted: {
      scenario: extracted.scenario,
      language: extracted.language,
      module: extracted.module,
      queries: extracted.queries,
    },
  };
}

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
  copyFirstString(hostTurnMeta, 'threadId', meta, ['threadId', 'thread_id', 'codexThreadId']);
  copyFirstString(hostTurnMeta, 'conversationId', meta, ['conversationId', 'conversation_id']);
  copyFirstString(hostTurnMeta, 'sessionId', meta, ['sessionId', 'session_id']);
  copyFirstString(hostTurnMeta, 'turnId', meta, ['turnId', 'turn_id']);
  copyFirstString(hostTurnMeta, 'messageId', meta, ['messageId', 'message_id']);
  copyFirstString(hostTurnMeta, 'source', meta, ['source', 'hostSource']);
  copyFirstString(hostTurnMeta, 'surface', meta, ['surface', 'hostSurface']);
  copyFirstString(hostTurnMeta, 'timestamp', meta, ['timestamp', 'createdAt']);
  copyFirstString(hostTurnMeta, 'language', meta, ['language']);
  copyFirstString(hostTurnMeta, 'activeFile', meta, ['activeFile', 'filePath']);
  copyFirstString(hostTurnMeta, 'cwd', meta, ['cwd']);
  copyFirstString(hostTurnMeta, 'projectRoot', meta, ['projectRoot']);
  copyFirstString(hostTurnMeta, 'workspaceRoot', meta, ['workspaceRoot']);
  return Object.keys(hostTurnMeta).length > 0 ? hostTurnMeta : undefined;
}

function normalizeHostDeclaredIntent(input: unknown): {
  value?: NormalizedHostDeclaredIntent;
  degradedReasons: string[];
} {
  if (input === undefined || input === null) {
    return { degradedReasons: [] };
  }
  const record = asRecord(input);
  if (!record) {
    return { degradedReasons: ['hostDeclaredIntent.notObject'] };
  }

  const value: NormalizedHostDeclaredIntent = {};
  assignString(value, 'query', record.query, 1200);
  assignString(value, 'summary', record.summary, 1200);
  assignString(value, 'goal', record.goal, 600);
  assignString(value, 'action', record.action, 600);
  assignString(value, 'scenario', record.scenario, 80);
  assignString(value, 'language', record.language, 80);
  assignString(value, 'module', record.module, 160);
  assignString(value, 'source', record.source, 120);

  const labels = normalizeStringArray(record.labels, 12, 80);
  if (labels.length > 0) {
    value.labels = labels;
  }
  if (typeof record.confidence === 'number' && Number.isFinite(record.confidence)) {
    value.confidence = Math.max(0, Math.min(1, record.confidence));
  }

  return Object.keys(value).length > 0
    ? { value, degradedReasons: [] }
    : { degradedReasons: ['hostDeclaredIntent.emptyAfterAllowlist'] };
}

function normalizeHostTurnMeta(input: unknown): {
  value?: NormalizedHostTurnMeta;
  degradedReasons: string[];
} {
  if (input === undefined || input === null) {
    return { degradedReasons: [] };
  }
  const record = asRecord(input);
  if (!record) {
    return { degradedReasons: ['hostTurnMeta.notObject'] };
  }

  const value: NormalizedHostTurnMeta = { redactions: [] };
  assignString(value, 'turnId', firstValue(record, ['turnId', 'turn_id']), 160);
  assignString(value, 'messageId', firstValue(record, ['messageId', 'message_id']), 160);
  assignString(value, 'source', record.source, 120);
  assignString(value, 'surface', record.surface, 120);
  assignString(value, 'timestamp', record.timestamp, 120);
  assignString(value, 'language', record.language, 80);

  assignHashedId(value, 'threadIdHash', firstValue(record, ['threadId', 'thread_id']));
  assignHashedId(
    value,
    'conversationIdHash',
    firstValue(record, ['conversationId', 'conversation_id'])
  );
  assignHashedId(value, 'sessionIdHash', firstValue(record, ['sessionId', 'session_id']));

  markPathRedactions(value, record);
  value.redactions = uniqueStrings(value.redactions);
  return hasTurnMetaValue(value) ? { value, degradedReasons: [] } : { degradedReasons: [] };
}

function mergeHostTurnMeta(
  requestMeta?: NormalizedHostTurnMeta,
  explicitMeta?: NormalizedHostTurnMeta
): NormalizedHostTurnMeta | undefined {
  if (!requestMeta && !explicitMeta) {
    return undefined;
  }
  return {
    redactions: uniqueStrings([
      ...(requestMeta?.redactions ?? []),
      ...(explicitMeta?.redactions ?? []),
    ]),
    ...(requestMeta?.turnId ? { turnId: requestMeta.turnId } : {}),
    ...(requestMeta?.messageId ? { messageId: requestMeta.messageId } : {}),
    ...(requestMeta?.source ? { source: requestMeta.source } : {}),
    ...(requestMeta?.surface ? { surface: requestMeta.surface } : {}),
    ...(requestMeta?.timestamp ? { timestamp: requestMeta.timestamp } : {}),
    ...(requestMeta?.language ? { language: requestMeta.language } : {}),
    ...(requestMeta?.threadIdHash ? { threadIdHash: requestMeta.threadIdHash } : {}),
    ...(requestMeta?.conversationIdHash
      ? { conversationIdHash: requestMeta.conversationIdHash }
      : {}),
    ...(requestMeta?.sessionIdHash ? { sessionIdHash: requestMeta.sessionIdHash } : {}),
    ...(explicitMeta?.turnId ? { turnId: explicitMeta.turnId } : {}),
    ...(explicitMeta?.messageId ? { messageId: explicitMeta.messageId } : {}),
    ...(explicitMeta?.source ? { source: explicitMeta.source } : {}),
    ...(explicitMeta?.surface ? { surface: explicitMeta.surface } : {}),
    ...(explicitMeta?.timestamp ? { timestamp: explicitMeta.timestamp } : {}),
    ...(explicitMeta?.language ? { language: explicitMeta.language } : {}),
    ...(explicitMeta?.threadIdHash ? { threadIdHash: explicitMeta.threadIdHash } : {}),
    ...(explicitMeta?.conversationIdHash
      ? { conversationIdHash: explicitMeta.conversationIdHash }
      : {}),
    ...(explicitMeta?.sessionIdHash ? { sessionIdHash: explicitMeta.sessionIdHash } : {}),
  };
}

function resolveSource(
  hasUserQuery: boolean,
  hasHostDeclaredIntent: boolean
): HostIntentFrameSource {
  if (hasUserQuery && hasHostDeclaredIntent) {
    return 'mixed';
  }
  if (hasHostDeclaredIntent) {
    return 'host-declared';
  }
  return 'deterministic';
}

function resolveConfidence(input: NormalizedHostIntentInput): number {
  if (input.hostDeclaredIntent?.confidence !== undefined) {
    return input.hostDeclaredIntent.confidence;
  }
  return input.source === 'deterministic' ? 1 : 0.75;
}

function hasTurnMetaValue(value: NormalizedHostTurnMeta): boolean {
  return Object.keys(value).some((key) => key !== 'redactions') || value.redactions.length > 0;
}

function assignString(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  maxLength: number
): void {
  const normalized = normalizeString(value, maxLength);
  if (normalized) {
    target[key] = normalized;
  }
}

function assignHashedId(
  target: NormalizedHostTurnMeta,
  key: 'threadIdHash' | 'conversationIdHash' | 'sessionIdHash',
  value: unknown
): void {
  const normalized = normalizeString(value, 400);
  if (!normalized) {
    return;
  }
  target[key] = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  target.redactions.push(key.replace(/Hash$/, ''));
}

function markPathRedactions(target: NormalizedHostTurnMeta, record: Record<string, unknown>): void {
  for (const key of ['activeFile', 'filePath', 'cwd', 'projectRoot', 'workspaceRoot']) {
    if (normalizeString(record[key], 1600)) {
      target.redactions.push(key);
    }
  }
}

function firstValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function firstDefinedString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}

function copyFirstString(
  target: HostTurnMetaInput,
  targetKey: keyof HostTurnMetaInput,
  source: Record<string, unknown>,
  sourceKeys: string[]
): void {
  const value = normalizeString(firstValue(source, sourceKeys), 1600);
  if (value) {
    target[targetKey] = value;
  }
}

function normalizeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function normalizeStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    const normalized = normalizeString(item, maxLength);
    if (normalized) {
      result.push(normalized);
    }
    if (result.length >= maxItems) {
      break;
    }
  }
  return uniqueStrings(result);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
