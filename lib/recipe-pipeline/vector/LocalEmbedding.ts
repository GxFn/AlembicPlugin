/**
 * LocalEmbedding — Plugin-side local Ollama embedding wiring (GMAP-L2/L3).
 *
 * Consumes the accepted Core L1 surface (@alembic/core/vector: OllamaEmbedProvider +
 * EmbedProviderSelector). This module owns ONLY the Plugin concerns: resolving the
 * localEmbedding config (config.json + host env), detecting a local Ollama daemon,
 * and selecting a local-first EmbedProvider lane. The plugin never downloads or
 * packages an embedding model; an already-running local Ollama is auto-detected.
 *
 * The plugin exposes the same setup path to every host surface that loads this
 * runtime; no alternate embedding provider is hidden behind this module.
 */
import {
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
export const DEFAULT_OLLAMA_PROBE_TIMEOUT_MS = 1_500;

export const LocalEmbeddingLaneOrderSchema = z.enum(['local-first', 'keyword-only']);

export const LocalEmbeddingConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
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
    timeoutMs: DEFAULT_OLLAMA_PROBE_TIMEOUT_MS,
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
  const provider = new OllamaEmbedProvider({
    model: config.model,
    endpoint: config.endpoint,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const ollamaLane: EmbedLane = {
    name: 'ollama',
    provider,
    isAvailable: async () => {
      const probe = await detectOllamaEmbedding(config, opts.fetchImpl);
      if (!probe.available) {
        throw new Error(probe.reason ?? 'local Ollama embedding is unavailable');
      }
      return true;
    },
  };
  const lanes = [ollamaLane, ...(opts.residentLane ? [opts.residentLane] : []), keywordEmbedLane()];
  return selectEmbedLane(lanes);
}

/**
 * L2 user-facing install/setup guidance. The plugin never downloads or packages a model.
 */
export function localEmbeddingSetupGuidance(config: LocalEmbeddingConfig): string[] {
  return [
    'Local semantic embeddings auto-detect your own Ollama daemon; Alembic never downloads a model.',
    '  1. Install Ollama: https://ollama.com/download',
    `  2. Pull an embedding model: ollama pull ${config.model}`,
    `  3. Make sure the daemon is reachable at ${config.endpoint} (GET /api/tags).`,
    '  4. Optional overrides: ALEMBIC_OLLAMA_ENDPOINT / ALEMBIC_OLLAMA_EMBED_MODEL.',
    'Set ALEMBIC_LOCAL_EMBEDDING_ENABLED=0, vector.localEmbedding.enabled=false, or',
    'laneOrder=keyword-only to disable probing. Absent services/models fall back to keyword search.',
  ];
}
