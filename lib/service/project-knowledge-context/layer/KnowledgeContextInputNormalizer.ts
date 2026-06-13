import {
  type KnowledgeContextDetailLevel,
  type KnowledgeContextFreshness,
  KnowledgeContextFreshnessSchema,
  type KnowledgeContextToolInput,
  KnowledgeContextToolInputSchema,
  type KnowledgeContextToolName,
} from '../contracts/index.js';
import {
  type ContextBudgeter,
  defaultContextBudgeter,
  type KnowledgeContextBudgetLimits,
} from '../support/index.js';

export interface NormalizedKnowledgeContextInput {
  activeFile?: string;
  agentHost?: string;
  budget: KnowledgeContextBudgetLimits;
  detailLevel: KnowledgeContextDetailLevel;
  filters?: Record<string, unknown>;
  freshnessPolicy: KnowledgeContextFreshness;
  inputSource?: string;
  intentKind?: string;
  intentRef?: string;
  language?: string;
  operation: string;
  primeRef?: string;
  projectRoot?: string;
  query?: string;
  rawInput: KnowledgeContextToolInput;
  recognizedIntent?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  sourceEvidenceRefs: string[];
  sourceGraphRef?: string;
  sourceRefs: string[];
  tool: KnowledgeContextToolName;
  workRef?: string;
}

export class KnowledgeContextInputNormalizer {
  constructor(private readonly budgeter: ContextBudgeter = defaultContextBudgeter) {}

  normalize(tool: KnowledgeContextToolName, input: unknown): NormalizedKnowledgeContextInput {
    const rawInput = this.parseToolInput(tool, input);
    const record = rawInput as Record<string, unknown>;
    const recognizedIntent = readRecord(record.recognizedIntent);
    const hostDeclaredIntent = readRecord(record.hostDeclaredIntent);
    const query =
      readString(record.query) ??
      readString(recognizedIntent?.query) ??
      readString(hostDeclaredIntent?.query);
    const freshnessPolicy = KnowledgeContextFreshnessSchema.parse(record.freshnessPolicy ?? {});

    return {
      rawInput,
      tool,
      operation: readString(record.operation) ?? 'auto',
      budget: this.budgeter.normalize(rawInput.budget),
      detailLevel: rawInput.detailLevel,
      freshnessPolicy,
      sourceRefs: readStringArray(record.sourceRefs),
      sourceEvidenceRefs: readStringArray(record.sourceEvidenceRefs),
      ...(readString(record.activeFile) === undefined
        ? {}
        : { activeFile: readString(record.activeFile) }),
      ...(readString(record.agentHost) === undefined
        ? {}
        : { agentHost: readString(record.agentHost) }),
      ...(readRecord(record.filters) === undefined ? {} : { filters: readRecord(record.filters) }),
      ...(readString(record.inputSource) === undefined
        ? {}
        : { inputSource: readString(record.inputSource) }),
      ...(readString(record.intentKind) === undefined
        ? {}
        : { intentKind: readString(record.intentKind) }),
      ...(readString(record.intentRef) === undefined
        ? {}
        : { intentRef: readString(record.intentRef) }),
      ...(readString(record.language) === undefined
        ? {}
        : { language: readString(record.language) }),
      ...(readString(record.primeRef) === undefined
        ? {}
        : { primeRef: readString(record.primeRef) }),
      ...(readString(record.projectRoot) === undefined
        ? {}
        : { projectRoot: readString(record.projectRoot) }),
      ...(query === undefined ? {} : { query }),
      ...(recognizedIntent === undefined ? {} : { recognizedIntent }),
      ...(readRecord(record.scope) === undefined ? {} : { scope: readRecord(record.scope) }),
      ...(readString(record.sourceGraphRef) === undefined
        ? {}
        : { sourceGraphRef: readString(record.sourceGraphRef) }),
      ...(readString(record.workRef) === undefined ? {} : { workRef: readString(record.workRef) }),
    };
  }

  private parseToolInput(
    tool: KnowledgeContextToolName,
    input: unknown
  ): KnowledgeContextToolInput {
    const objectInput = toRecord(input);
    return KnowledgeContextToolInputSchema.parse({ ...objectInput, tool });
  }
}

function toRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export const defaultKnowledgeContextInputNormalizer = new KnowledgeContextInputNormalizer();
