import type { NormalizedKnowledgeContextInput } from '../layer/KnowledgeContextInputNormalizer.js';

export interface KnowledgeContextInteractionState {
  currentTask?: Record<string, unknown>;
  intentRef?: string;
  primeRef?: string;
  recognizedIntent?: Record<string, unknown>;
  sourceEvidenceRefs: string[];
  workRef?: string;
}

export interface InteractionStateProvider {
  resolveInteractionState(input: NormalizedKnowledgeContextInput): KnowledgeContextInteractionState;
}

export class DefaultInteractionStateProvider implements InteractionStateProvider {
  resolveInteractionState(
    input: NormalizedKnowledgeContextInput
  ): KnowledgeContextInteractionState {
    const currentTask = resolveCurrentTask(input);
    return {
      ...(currentTask === undefined ? {} : { currentTask }),
      ...(input.intentRef === undefined ? {} : { intentRef: input.intentRef }),
      ...(input.primeRef === undefined ? {} : { primeRef: input.primeRef }),
      ...(input.workRef === undefined ? {} : { workRef: input.workRef }),
      ...(input.recognizedIntent === undefined
        ? {}
        : { recognizedIntent: input.recognizedIntent as Record<string, unknown> }),
      sourceEvidenceRefs: input.sourceEvidenceRefs,
    };
  }
}

export const defaultInteractionStateProvider = new DefaultInteractionStateProvider();

function resolveCurrentTask(
  input: NormalizedKnowledgeContextInput
): Record<string, unknown> | undefined {
  const hostDeclaredIntent = readRecord(input.rawInput.hostDeclaredIntent);
  const recognizedIntent = input.recognizedIntent;
  const query =
    readString(recognizedIntent?.query) ?? readString(hostDeclaredIntent?.query) ?? input.query;
  const action = readString(recognizedIntent?.action) ?? readString(hostDeclaredIntent?.action);
  const target = readString(recognizedIntent?.target) ?? readString(hostDeclaredIntent?.target);
  const confidence =
    readNumber(recognizedIntent?.confidence) ?? readNumber(hostDeclaredIntent?.confidence);

  if (
    query === undefined &&
    action === undefined &&
    target === undefined &&
    input.intentRef === undefined &&
    input.workRef === undefined
  ) {
    return undefined;
  }

  return {
    ...(action === undefined ? {} : { action }),
    ...(target === undefined ? {} : { target }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(query === undefined ? {} : { query }),
    ...(input.intentKind === undefined ? {} : { intentKind: input.intentKind }),
    ...(input.inputSource === undefined ? {} : { inputSource: input.inputSource }),
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(input.activeFile === undefined ? {} : { activeFile: input.activeFile }),
    ...(input.intentRef === undefined ? {} : { intentRef: input.intentRef }),
    ...(input.primeRef === undefined ? {} : { primeRef: input.primeRef }),
    ...(input.workRef === undefined ? {} : { workRef: input.workRef }),
    sourceEvidenceRefs: input.sourceEvidenceRefs,
    sourceRefs: input.sourceRefs,
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
