import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { KnowledgeContextToolName, KnowledgeContextToolOutput } from '../contracts/index.js';
import {
  type ContextIndexSnapshotOptions,
  createContextIndexSnapshot,
} from './ContextIndexSnapshot.js';
import {
  defaultKnowledgeContextInputNormalizer,
  type KnowledgeContextInputNormalizer,
} from './KnowledgeContextInputNormalizer.js';
import {
  defaultKnowledgeContextOutputProjector,
  type KnowledgeContextOutputProjector,
  type KnowledgeContextProjectionPayload,
} from './KnowledgeContextOutputProjector.js';
import { defaultRetrievalPlanner, type RetrievalPlanner } from './RetrievalPlanner.js';

export interface ResolveKnowledgeContextOptions {
  payload?: KnowledgeContextProjectionPayload;
  snapshot?: ContextIndexSnapshotOptions;
}

export interface ProjectKnowledgeContextLayerOptions {
  inputNormalizer?: KnowledgeContextInputNormalizer;
  outputProjector?: KnowledgeContextOutputProjector;
  retrievalPlanner?: RetrievalPlanner;
}

export class ProjectKnowledgeContextLayer {
  private readonly inputNormalizer: KnowledgeContextInputNormalizer;
  private readonly outputProjector: KnowledgeContextOutputProjector;
  private readonly retrievalPlanner: RetrievalPlanner;

  constructor(options: ProjectKnowledgeContextLayerOptions = {}) {
    this.inputNormalizer = options.inputNormalizer ?? defaultKnowledgeContextInputNormalizer;
    this.outputProjector = options.outputProjector ?? defaultKnowledgeContextOutputProjector;
    this.retrievalPlanner = options.retrievalPlanner ?? defaultRetrievalPlanner;
  }

  resolve(
    tool: KnowledgeContextToolName,
    input: unknown,
    options: ResolveKnowledgeContextOptions = {}
  ): KnowledgeContextToolOutput {
    const normalized = this.inputNormalizer.normalize(tool, input);
    const snapshot = createContextIndexSnapshot(normalized, options.snapshot);
    const plan = this.retrievalPlanner.plan(normalized, snapshot);
    return this.outputProjector.project({
      input: normalized,
      snapshot,
      plan,
      payload: options.payload,
    });
  }

  resolveMcpResult(
    tool: KnowledgeContextToolName,
    input: unknown,
    options: ResolveKnowledgeContextOptions = {}
  ): CallToolResult {
    const normalized = this.inputNormalizer.normalize(tool, input);
    const snapshot = createContextIndexSnapshot(normalized, options.snapshot);
    const plan = this.retrievalPlanner.plan(normalized, snapshot);
    return this.outputProjector.projectMcpResult({
      input: normalized,
      snapshot,
      plan,
      payload: options.payload,
    });
  }

  resolveProjectMatrix(input: unknown, options: ResolveKnowledgeContextOptions = {}) {
    return this.resolve('alembic_project_matrix', input, options);
  }

  resolveKnowledgeRetrieval(input: unknown, options: ResolveKnowledgeContextOptions = {}) {
    return this.resolve('alembic_search', input, options);
  }

  resolveProjectGraph(input: unknown, options: ResolveKnowledgeContextOptions = {}) {
    return this.resolve('alembic_graph', input, options);
  }

  resolvePrimeContext(input: unknown, options: ResolveKnowledgeContextOptions = {}) {
    return this.resolve('alembic_prime', input, options);
  }
}

export const defaultProjectKnowledgeContextLayer = new ProjectKnowledgeContextLayer();
