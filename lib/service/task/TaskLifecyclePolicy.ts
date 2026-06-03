/**
 * TaskLifecyclePolicy — Codex-aware alembic_task lifecycle decisions.
 *
 * 这个策略层只处理 Plugin 内部的 Codex task 触发语义：它不创建任务、
 * 不写入状态，也不替 Guard 执行检查。handler 负责真实 MCP 响应，policy
 * 负责把 Codex turn、task anchor 和 git diff 证据收束成可解释的决定。
 */

import path from 'node:path';
import type { HostIntentFrame } from './HostIntentFrame.js';

export type TaskLifecycleInputSource =
  | 'user-intent'
  | 'automation-envelope'
  | 'direct-thread-follow-up'
  | 'system-or-tool-continuation'
  | 'status-or-readonly'
  | 'unknown';

export type TaskLifecycleIntentKind =
  | 'code-change-task'
  | 'read-only-analysis'
  | 'design-discussion'
  | 'status-report'
  | 'automation-control'
  | 'knowledge-query'
  | 'explicit-task-anchor'
  | 'unknown';

export interface PrimeDecision {
  action: 'run' | 'skip';
  curatedQuery?: string;
  keywords?: string[];
  reasonCode:
    | 'knowledge-ready-code-task'
    | 'knowledge-ready-user-query'
    | 'automation-envelope-needs-context'
    | 'uninitialized-project'
    | 'status-only'
    | 'no-semantic-query';
  sourceRefs?: string[];
}

export interface TaskAnchorDecision {
  action: 'create' | 'skip';
  confidence: 'high' | 'medium' | 'low';
  reasonCode:
    | 'explicit-code-change'
    | 'explicit-user-task-anchor'
    | 'multi-step-implementation'
    | 'readonly-no-anchor'
    | 'automation-envelope-no-anchor'
    | 'status-only-no-anchor';
}

export interface TaskCloseDecision {
  action: 'close' | 'skip';
  reasonCode: 'task-anchor-exists' | 'no-created-task';
  taskId?: string;
}

export interface GuardTriggerDecision {
  action: 'run' | 'skip';
  changedFiles: string[];
  guardRelevantFiles: string[];
  reasonCode:
    | 'task-scoped-code-diff'
    | 'no-code-diff'
    | 'docs-only-diff'
    | 'unrelated-dirty-diff'
    | 'no-task-anchor'
    | 'guard-not-relevant';
  taskScopedFiles: string[];
}

export interface TaskLifecycleClassification {
  closeDecision?: TaskCloseDecision;
  guardDecision?: GuardTriggerDecision;
  inputSource: TaskLifecycleInputSource;
  intentKind: TaskLifecycleIntentKind;
  primeDecision: PrimeDecision;
  taskAnchorDecision: TaskAnchorDecision;
}

export interface ClassifyTaskLifecycleInput {
  hostIntentFrame?: HostIntentFrame;
  operation?: string;
  rawUserQuery?: string;
  taskId?: string;
  title?: string;
  userQuery?: string;
}

export interface GuardTriggerInput {
  changedFiles: unknown;
  taskAnchorExists: boolean;
  taskScopeFiles?: unknown;
}

const SOURCE_EXTS = new Set([
  '.m',
  '.mm',
  '.h',
  '.swift',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.py',
  '.rb',
  '.java',
  '.kt',
  '.go',
  '.rs',
  '.c',
  '.cpp',
  '.cc',
  '.cs',
  '.vue',
  '.svelte',
]);

const AUTOMATION_ENVELOPE_PATTERNS = [
  /<codex_delegation/i,
  /\bControllerDispatchPacket\b/i,
  /\bControllerReturnEnvelope\b/i,
  /\bDeliveryEnvelope\b/i,
  /\bTargetResultEnvelope\b/i,
  /\bdispatchGroup\s*:/i,
  /\bcurrentWindow\s*:/i,
  /\bcontrollerWindow\s*:/i,
  /\btaskId\s*:/i,
  /继续当前窗口任务/i,
  /继续总控验收/i,
];

export function classifyTaskLifecycleInput(
  input: ClassifyTaskLifecycleInput
): TaskLifecycleClassification {
  const rawUserQuery = normalizeText(input.rawUserQuery);
  const userQuery =
    normalizeText(input.userQuery) ?? input.hostIntentFrame?.recognizedIntentDraft.query;
  const query = userQuery ?? '';
  const inputSource = classifyInputSource(input, rawUserQuery, query);
  const intentKind = classifyIntentKind(input, inputSource, query);
  const primeDecision = decidePrime(inputSource, intentKind, input.hostIntentFrame, query);
  const taskAnchorDecision = decideTaskAnchor(input, inputSource, intentKind, query);
  const closeDecision = decideClose(input.taskId);

  return {
    ...(closeDecision ? { closeDecision } : {}),
    inputSource,
    intentKind,
    primeDecision,
    taskAnchorDecision,
  };
}

export function decideGuardTrigger(input: GuardTriggerInput): GuardTriggerDecision {
  if (!input.taskAnchorExists) {
    return {
      action: 'skip',
      changedFiles: [],
      guardRelevantFiles: [],
      reasonCode: 'no-task-anchor',
      taskScopedFiles: [],
    };
  }

  const changedFiles = normalizeTaskLifecycleFileRefs(input.changedFiles);
  if (changedFiles.length === 0) {
    return {
      action: 'skip',
      changedFiles: [],
      guardRelevantFiles: [],
      reasonCode: 'no-code-diff',
      taskScopedFiles: [],
    };
  }

  const guardRelevantFiles = changedFiles.filter(isGuardRelevantSourceFile);
  if (guardRelevantFiles.length === 0) {
    return {
      action: 'skip',
      changedFiles,
      guardRelevantFiles,
      reasonCode: 'docs-only-diff',
      taskScopedFiles: [],
    };
  }

  const taskScopeFiles = normalizeTaskLifecycleFileRefs(input.taskScopeFiles);
  if (taskScopeFiles.length === 0) {
    return {
      action: 'skip',
      changedFiles,
      guardRelevantFiles,
      reasonCode: 'unrelated-dirty-diff',
      taskScopedFiles: [],
    };
  }

  const scoped = intersectFiles(guardRelevantFiles, taskScopeFiles);
  if (scoped.length === 0) {
    return {
      action: 'skip',
      changedFiles,
      guardRelevantFiles,
      reasonCode: 'unrelated-dirty-diff',
      taskScopedFiles: [],
    };
  }

  return {
    action: 'run',
    changedFiles,
    guardRelevantFiles,
    reasonCode: 'task-scoped-code-diff',
    taskScopedFiles: scoped,
  };
}

export function isGuardRelevantSourceFile(filePath: string): boolean {
  const normalized = normalizeTaskLifecycleFileRefs([filePath])[0];
  if (!normalized) {
    return false;
  }
  return SOURCE_EXTS.has(path.extname(normalized).toLowerCase());
}

export function normalizeTaskLifecycleFileRefs(
  value: unknown,
  options: { projectRoot?: string } = {}
): string[] {
  const rawValues = collectRawFileRefs(value);
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const normalized: string[] = [];

  for (const raw of rawValues) {
    const filePath = normalizeOneFileRef(raw, projectRoot);
    if (filePath) {
      normalized.push(filePath);
    }
  }

  return uniqueStrings(normalized);
}

export function looksLikeAutomationEnvelopeText(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return AUTOMATION_ENVELOPE_PATTERNS.some((pattern) => pattern.test(value));
}

function classifyInputSource(
  input: ClassifyTaskLifecycleInput,
  rawUserQuery: string | undefined,
  query: string
): TaskLifecycleInputSource {
  const turnMeta = input.hostIntentFrame?.hostTurnMeta;
  const source = String(turnMeta?.source ?? '').toLowerCase();
  const surface = String(turnMeta?.surface ?? '').toLowerCase();
  const hasCuratedIntent = hasCuratedHostDeclaredIntent(input.hostIntentFrame);
  if (
    !hasCuratedIntent &&
    (looksLikeAutomationEnvelopeText(rawUserQuery) || looksLikeAutomationEnvelopeText(query))
  ) {
    return 'automation-envelope';
  }
  if (source.includes('direct-thread') || surface.includes('direct-thread')) {
    return 'direct-thread-follow-up';
  }
  if (source.includes('system') || source.includes('tool')) {
    return 'system-or-tool-continuation';
  }
  if (isStatusOnlyQuery(query)) {
    return 'status-or-readonly';
  }
  if (input.hostIntentFrame || query) {
    return 'user-intent';
  }
  return 'unknown';
}

function hasCuratedHostDeclaredIntent(frame: HostIntentFrame | undefined): boolean {
  const declared = frame?.hostDeclaredIntent;
  return Boolean(
    declared?.query?.trim() ||
      declared?.summary?.trim() ||
      declared?.goal?.trim() ||
      declared?.action?.trim()
  );
}

function classifyIntentKind(
  input: ClassifyTaskLifecycleInput,
  inputSource: TaskLifecycleInputSource,
  query: string
): TaskLifecycleIntentKind {
  const lower = query.toLowerCase();
  const action = input.hostIntentFrame?.recognizedIntentDraft.action.toLowerCase() ?? '';
  if (inputSource === 'automation-envelope') {
    return 'automation-control';
  }
  if (
    input.operation === 'create' ||
    /\b(task anchor|create task|任务锚点|创建任务)\b/i.test(query)
  ) {
    return 'explicit-task-anchor';
  }
  if (isStatusOnlyQuery(query)) {
    return 'status-report';
  }
  if (
    action === 'implement' ||
    action === 'fix' ||
    action === 'refactor' ||
    action === 'remove' ||
    /\b(implement|fix|refactor|remove|delete|add|build)\b/.test(lower) ||
    /实现|修复|重构|删除|新增|开发/.test(query)
  ) {
    return 'code-change-task';
  }
  if (/\b(design|proposal|plan|dossier|contract)\b/.test(lower) || /需求|方案|设计/.test(query)) {
    return 'design-discussion';
  }
  if (action === 'review' || /\b(read|inspect|review|explain|status)\b/.test(lower)) {
    return 'read-only-analysis';
  }
  if (/\b(recipe|knowledge|search|guard)\b/.test(lower) || /知识|配方|搜索|规则/.test(query)) {
    return 'knowledge-query';
  }
  return query ? 'knowledge-query' : 'unknown';
}

function decidePrime(
  inputSource: TaskLifecycleInputSource,
  intentKind: TaskLifecycleIntentKind,
  hostIntentFrame: HostIntentFrame | undefined,
  query: string
): PrimeDecision {
  const sourceRefs = hostIntentFrame?.recognizedIntentDraft.sourceRefs ?? [];
  const keywords = uniqueStrings([
    ...(hostIntentFrame?.hostDeclaredIntent?.keywords ?? []),
    ...(hostIntentFrame?.hostDeclaredIntent?.labels ?? []),
  ]);
  if (!query.trim()) {
    return { action: 'skip', reasonCode: 'no-semantic-query' };
  }
  if (inputSource === 'automation-envelope') {
    return {
      action: 'skip',
      curatedQuery: query,
      reasonCode: 'automation-envelope-needs-context',
      ...(keywords.length > 0 ? { keywords } : {}),
      ...(sourceRefs.length > 0 ? { sourceRefs } : {}),
    };
  }
  if (intentKind === 'status-report') {
    return {
      action: 'skip',
      curatedQuery: query,
      reasonCode: 'status-only',
      ...(sourceRefs.length > 0 ? { sourceRefs } : {}),
    };
  }
  return {
    action: 'run',
    curatedQuery: query,
    reasonCode:
      intentKind === 'code-change-task'
        ? 'knowledge-ready-code-task'
        : 'knowledge-ready-user-query',
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(sourceRefs.length > 0 ? { sourceRefs } : {}),
  };
}

function decideTaskAnchor(
  input: ClassifyTaskLifecycleInput,
  inputSource: TaskLifecycleInputSource,
  intentKind: TaskLifecycleIntentKind,
  query: string
): TaskAnchorDecision {
  if (inputSource === 'automation-envelope') {
    return {
      action: 'skip',
      confidence: 'high',
      reasonCode: 'automation-envelope-no-anchor',
    };
  }
  if (intentKind === 'status-report') {
    return {
      action: 'skip',
      confidence: 'high',
      reasonCode: 'status-only-no-anchor',
    };
  }
  if (intentKind === 'explicit-task-anchor') {
    return {
      action: 'create',
      confidence: 'high',
      reasonCode: 'explicit-user-task-anchor',
    };
  }
  if (intentKind === 'code-change-task') {
    return {
      action: 'create',
      confidence: isMultiStepQuery(query) ? 'high' : 'medium',
      reasonCode: isMultiStepQuery(query) ? 'multi-step-implementation' : 'explicit-code-change',
    };
  }
  return {
    action: 'skip',
    confidence: intentKind === 'unknown' ? 'low' : 'high',
    reasonCode: 'readonly-no-anchor',
  };
}

function decideClose(taskId: string | undefined): TaskCloseDecision | undefined {
  if (taskId === undefined) {
    return undefined;
  }
  if (!taskId.trim()) {
    return { action: 'skip', reasonCode: 'no-created-task' };
  }
  return { action: 'close', reasonCode: 'task-anchor-exists', taskId };
}

function isStatusOnlyQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return (
    /\b(status|readback|summary|summarize|done|completed|waiting|pause)\b/.test(lower) ||
    /状态|回填|汇报|总结|暂停|等待/.test(query)
  );
}

function isMultiStepQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return (
    /\b(multi-step|implementation wave|refactor|integration|runtime|schema|tests?)\b/.test(lower) ||
    /多步|实现波次|重构|集成|运行时|测试/.test(query)
  );
}

function collectRawFileRefs(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const refs: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      refs.push(item);
      continue;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      for (const key of ['path', 'file', 'filePath']) {
        if (typeof record[key] === 'string') {
          refs.push(record[key]);
          break;
        }
      }
    }
  }
  return refs;
}

function normalizeOneFileRef(raw: string, projectRoot: string | undefined): string | null {
  const withoutLine = raw
    .trim()
    .replace(/^file:\/\//, '')
    .replace(/:(?:L|line-?|#L)?\d+(?:[:,-]\d+)?$/i, '');
  if (!withoutLine || withoutLine.startsWith('knowledge:') || withoutLine.startsWith('host:')) {
    return null;
  }

  const slashPath = withoutLine.replace(/\\/g, '/');
  const relative = path.isAbsolute(slashPath)
    ? projectRoot
      ? path.relative(projectRoot, slashPath)
      : ''
    : slashPath;
  const normalized = relative.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    path.isAbsolute(normalized)
  ) {
    return null;
  }
  if (normalized.includes('\0') || normalized.endsWith('/')) {
    return null;
  }
  return normalized;
}

function normalizeProjectRoot(projectRoot: string | undefined): string | undefined {
  if (!projectRoot?.trim()) {
    return undefined;
  }
  return path.resolve(projectRoot.trim()).replace(/\\/g, '/');
}

function intersectFiles(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((filePath) => rightSet.has(filePath));
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}
