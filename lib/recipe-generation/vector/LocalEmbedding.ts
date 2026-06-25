/**
 * LocalEmbedding — Plugin-side local Ollama embedding wiring (GMAP-L2/L3).
 *
 * Consumes the accepted Core L1 surface (@alembic/core/vector: OllamaEmbedProvider +
 * EmbedProviderSelector). This module owns ONLY the Plugin concerns: resolving the
 * localEmbedding config (config.json + host env), detecting a local Ollama daemon,
 * and selecting a local-first EmbedProvider lane. The plugin never downloads or
 * packages an embedding model; users opt in by running Ollama locally.
 *
 * The plugin exposes the same setup path to every host surface that loads this
 * runtime; no alternate embedding provider is hidden behind this module.
 */
import {
  buildLocalFirstEmbedLanes,
  type EmbedLane,
  type EmbedLaneSelection,
  type FetchLike,
  keywordEmbedLane,
  OllamaEmbedProvider,
  type OllamaProbeResult,
  selectEmbedLane,
} from '@alembic/core/vector';
import { z } from 'zod';

export const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_EMBED_MODEL = 'qwen3-embedding';

export const LocalEmbeddingLaneOrderSchema = z.enum(['local-first', 'keyword-only']);

export const LocalEmbeddingConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    endpoint: z.string().min(1).max(2000).default(DEFAULT_OLLAMA_ENDPOINT),
    model: z.string().min(1).max(200).default(DEFAULT_OLLAMA_EMBED_MODEL),
    laneOrder: LocalEmbeddingLaneOrderSchema.default('local-first'),
  })
  .strict();
export type LocalEmbeddingConfig = z.infer<typeof LocalEmbeddingConfigSchema>;

function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) {
    return false;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve the localEmbedding config from config.json (vector.localEmbedding) with host
 * env overrides (env wins): ALEMBIC_LOCAL_EMBEDDING_ENABLED / ALEMBIC_OLLAMA_ENDPOINT /
 * ALEMBIC_OLLAMA_EMBED_MODEL.
 */
export function resolveLocalEmbeddingConfig(
  vectorConfig: unknown,
  env: NodeJS.ProcessEnv = process.env
): LocalEmbeddingConfig {
  const fromConfig =
    isRecord(vectorConfig) && isRecord(vectorConfig.localEmbedding)
      ? vectorConfig.localEmbedding
      : {};
  const enabledEnv = parseBoolEnv(env.ALEMBIC_LOCAL_EMBEDDING_ENABLED);
  const endpointEnv = env.ALEMBIC_OLLAMA_ENDPOINT?.trim();
  const modelEnv = env.ALEMBIC_OLLAMA_EMBED_MODEL?.trim();
  return LocalEmbeddingConfigSchema.parse({
    ...fromConfig,
    ...(enabledEnv === undefined ? {} : { enabled: enabledEnv }),
    ...(endpointEnv ? { endpoint: endpointEnv } : {}),
    ...(modelEnv ? { model: modelEnv } : {}),
  });
}

/**
 * L2 detection: probe a local Ollama embedding endpoint + model. Non-throwing — Core's
 * OllamaEmbedProvider.probe() returns a structured result (available + reason + models)
 * and tolerates a tag suffix (e.g. model:latest).
 */
export function detectOllamaEmbedding(
  config: Pick<LocalEmbeddingConfig, 'endpoint' | 'model'>,
  fetchImpl?: FetchLike
): Promise<OllamaProbeResult> {
  return new OllamaEmbedProvider({
    model: config.model,
    endpoint: config.endpoint,
    ...(fetchImpl ? { fetchImpl } : {}),
  }).probe();
}

/**
 * L3 selection: build the local-first lane order and select the first available provider
 * via the Core EmbedProviderSelector. Ollama (enabled + reachable + model pulled) → keyword
 * baseline (null provider, vectors disabled). The resident lane slot is reserved (the
 * resident mirror does search, not raw embedding — GMAP-9). Returns the selection plus
 * honest per-lane diagnostics; never throws on an absent daemon.
 */
export function selectLocalEmbedLane(
  config: LocalEmbeddingConfig,
  opts: { residentLane?: EmbedLane; fetchImpl?: FetchLike } = {}
): Promise<EmbedLaneSelection> {
  if (!config.enabled || config.laneOrder === 'keyword-only') {
    return selectEmbedLane([keywordEmbedLane()]);
  }
  const lanes = buildLocalFirstEmbedLanes({
    ollama: {
      model: config.model,
      endpoint: config.endpoint,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    },
    ...(opts.residentLane ? { resident: opts.residentLane } : {}),
  });
  return selectEmbedLane(lanes);
}

/**
 * L2 user-facing install/setup guidance. The plugin never downloads or packages a model.
 */
export function localEmbeddingSetupGuidance(config: LocalEmbeddingConfig): string[] {
  return [
    'Local semantic embeddings are optional and run through your own Ollama daemon.',
    '  1. Install Ollama: https://ollama.com/download',
    `  2. Pull an embedding model: ollama pull ${config.model}`,
    `  3. Make sure the daemon is reachable at ${config.endpoint} (GET /api/tags).`,
    '  4. Enable it: set vector.localEmbedding.enabled=true in .asd/config.json, or export',
    '     ALEMBIC_LOCAL_EMBEDDING_ENABLED=1 (optionally ALEMBIC_OLLAMA_ENDPOINT /',
    '     ALEMBIC_OLLAMA_EMBED_MODEL).',
    'When Ollama is absent or disabled, Alembic cleanly falls back to keyword search.',
  ];
}
