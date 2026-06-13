import type { NormalizedKnowledgeContextInput } from '../layer/KnowledgeContextInputNormalizer.js';

export interface KnowledgeContextInteractionState {
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
    return {
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
