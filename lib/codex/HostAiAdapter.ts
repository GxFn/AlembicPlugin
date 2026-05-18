import Logger from '@alembic/core/logging';
import { PROVIDER_KEY_ENV } from '@alembic/core/shared';
import { inspectCodexAiConfig } from './AiConfigState.js';

export interface HostAiProvider {
  name: string;
  model: string;
  provider?: string;
  type?: string;
  __hostAiExecutable?: boolean;
  __hostEmbedExecutable?: boolean;
  _onTokenUsage?: ((usage: TokenUsagePayload) => void) | null;
  supportsEmbedding: () => boolean;
  chat: (prompt: string, options?: Record<string, unknown>) => Promise<string>;
  chatWithTools: (prompt: string, options?: Record<string, unknown>) => Promise<unknown>;
  chatWithStructuredOutput: (prompt: string, options?: Record<string, unknown>) => Promise<unknown>;
  enrichCandidates: (
    candidates: unknown[],
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>[]>;
  embed: (text: string) => Promise<number[]>;
  probe: () => Promise<void>;
  [key: string]: unknown;
}

export interface TokenUsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  source?: string;
}

export interface TokenRecorder {
  record(record: {
    inputTokens: number;
    outputTokens: number;
    model?: string;
    provider?: string;
    source: string;
  }): void;
}

export interface HostProviderInfo {
  isMock: boolean;
  model: string;
  name: string;
  supportsEmbedding: boolean;
}

export interface HostProviderSwitchResult {
  clearedSingletons: string[];
  current: HostProviderInfo;
  previous: HostProviderInfo;
}

export type HostProviderSwitchListener = (result: HostProviderSwitchResult) => void;

export interface HostAiProviderOption {
  id: string;
  label: string;
  defaultModel: string;
  models: HostAiModelOption[];
  hasKey: boolean;
  isActive: boolean;
  keyEnvVar: string;
  baseUrl: string;
}

export interface HostAiModelOption {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  deprecated?: boolean;
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    structuredOutput: boolean;
    embeddings: boolean;
  };
  reasoning: {
    supported: boolean;
    mode?: string;
    defaultEffort?: string;
    effortLevels?: string[];
  };
}

interface HostProviderConfig {
  id: string;
  displayName: string;
  defaultModel: string;
  keyEnvVar: string;
  baseUrl: string;
}

const HOST_PROVIDER_CONFIGS: HostProviderConfig[] = [
  {
    id: 'google',
    displayName: 'Google Gemini',
    defaultModel: 'gemini-3-flash-preview',
    keyEnvVar: 'ALEMBIC_GOOGLE_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    defaultModel: 'gpt-5.5',
    keyEnvVar: 'ALEMBIC_OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    defaultModel: 'deepseek-v4-flash',
    keyEnvVar: 'ALEMBIC_DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com',
  },
  {
    id: 'claude',
    displayName: 'Claude',
    defaultModel: 'claude-sonnet-4-6',
    keyEnvVar: 'ALEMBIC_CLAUDE_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1',
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    defaultModel: 'llama3',
    keyEnvVar: '',
    baseUrl: 'http://127.0.0.1:11434/v1',
  },
];

export class HostAiProviderManager {
  #clearDependents: (() => string[]) | null = null;
  #embedProvider: HostAiProvider | null = null;
  #listeners = new Set<HostProviderSwitchListener>();
  #logger = Logger.getInstance();
  #provider: HostAiProvider;
  #syncToDi: ((provider: HostAiProvider | null, embed: HostAiProvider | null) => void) | null =
    null;
  #tokenRecorder: TokenRecorder | null = null;

  constructor(initialProvider: HostAiProvider | null = null) {
    this.#provider = normalizeHostProvider(initialProvider);
    this.#wireTokenTracking();
  }

  get provider(): HostAiProvider {
    return this.#provider;
  }

  get runtimeProvider(): HostAiProvider | null {
    return hasChatCapability(this.#provider) ? this.#provider : null;
  }

  get embedProvider(): HostAiProvider | null {
    return this.#embedProvider ?? this.runtimeProvider;
  }

  get rawEmbedProvider(): HostAiProvider | null {
    return this.#embedProvider;
  }

  get isMock(): boolean {
    return !this.isReady;
  }

  get isReady(): boolean {
    return this.#provider.__hostAiExecutable === true;
  }

  get name(): string {
    return String(this.#provider.name || 'mock');
  }

  get model(): string {
    return String(this.#provider.model || defaultModelForProvider(this.name));
  }

  get info(): HostProviderInfo {
    return {
      name: this.name,
      model: this.model,
      isMock: this.isMock,
      supportsEmbedding: providerSupportsEmbedding(this.#provider),
    };
  }

  switchProvider(newProvider: HostAiProvider): HostProviderSwitchResult {
    const previous = this.info;
    this.#provider = normalizeHostProvider(newProvider);
    this.#wireTokenTracking();
    this.#syncToDi?.(this.runtimeProvider, this.embedProvider);
    const clearedSingletons = this.#clearDependents?.() ?? [];
    const result = {
      previous,
      current: this.info,
      clearedSingletons,
    };

    for (const listener of this.#listeners) {
      try {
        listener(result);
      } catch {
        /* listener failure must not break provider switching */
      }
    }

    this.#logger.info('[HostAiProviderManager] Provider selection updated', {
      from: `${previous.name}/${previous.model}`,
      to: `${result.current.name}/${result.current.model}`,
      executable: !result.current.isMock,
      cleared: clearedSingletons,
    });

    return result;
  }

  setEmbedProvider(provider: HostAiProvider | null): void {
    this.#embedProvider =
      provider && hasEmbeddingCapability(provider) ? normalizeHostProvider(provider) : null;
    this.#syncToDi?.(this.runtimeProvider, this.embedProvider);
  }

  setTokenRecorder(recorder: TokenRecorder): void {
    this.#tokenRecorder = recorder;
    this.#wireTokenTracking();
  }

  onSwitch(listener: HostProviderSwitchListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  _bindDependentClearer(fn: () => string[]): void {
    this.#clearDependents = fn;
  }

  _bindEmbedFallbackInit(_fn: (provider: HostAiProvider) => HostAiProvider | null): void {
    // Provider fallback execution lives in the host agent. The plugin only records host state.
  }

  _bindDiSync(fn: (provider: HostAiProvider | null, embed: HostAiProvider | null) => void): void {
    this.#syncToDi = fn;
  }

  #wireTokenTracking(): void {
    if (!this.#provider || typeof this.#provider !== 'object') {
      return;
    }
    this.#provider._onTokenUsage = (usage: TokenUsagePayload) => {
      if (!this.#tokenRecorder) {
        return;
      }
      try {
        this.#tokenRecorder.record({
          source: usage.source || 'host-agent',
          provider: this.name,
          model: this.model,
          inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0,
        });
      } catch {
        /* token tracking is best-effort */
      }
    };
  }
}

export function createHostAiProviderManager(
  initialProvider: HostAiProvider | null = null
): HostAiProviderManager {
  return new HostAiProviderManager(initialProvider);
}

export function createHostManagedProvider(options: {
  model?: string | null;
  provider?: string | null;
}): HostAiProvider {
  const provider =
    normalizeProviderName(options.provider || process.env.ALEMBIC_AI_PROVIDER) || 'mock';
  return {
    name: provider,
    model: options.model || process.env.ALEMBIC_AI_MODEL || defaultModelForProvider(provider),
    hostManaged: true,
    __hostAiExecutable: false,
    __hostEmbedExecutable: false,
    ...unavailableProviderMethods(),
  };
}

export function readHostAiConfigInfo(projectRoot: string): {
  hasKey: boolean;
  keys: Record<string, boolean>;
  model: string | null;
  provider: string | null;
  ready: boolean;
} {
  const state = inspectCodexAiConfig(projectRoot);
  const keys = Object.fromEntries(
    Object.entries(PROVIDER_KEY_ENV).map(([provider, envKey]) => [
      provider,
      Boolean(state.vars[envKey] && state.vars[envKey] !== '********'),
    ])
  );
  return {
    provider: state.provider,
    model: state.model,
    hasKey: Boolean(state.provider && keys[state.provider]),
    keys,
    ready: state.ready,
  };
}

export function listHostAiProviders(
  options: {
    activeModel?: string;
    activeProvider?: string;
    env?: Record<string, string | undefined>;
  } = {}
): HostAiProviderOption[] {
  const activeProvider = normalizeProviderName(options.activeProvider || '') || '';
  const activeModel = options.activeModel || '';
  const env = options.env || process.env;
  return [
    ...HOST_PROVIDER_CONFIGS.map((provider) => ({
      id: provider.id,
      label: provider.displayName,
      defaultModel: provider.defaultModel,
      models: [modelOption(provider.id, provider.defaultModel)],
      hasKey: provider.keyEnvVar ? Boolean(env[provider.keyEnvVar]) : true,
      isActive: provider.id === activeProvider,
      keyEnvVar: provider.keyEnvVar,
      baseUrl: provider.baseUrl,
    })),
    {
      id: 'mock',
      label: 'Mock (测试)',
      defaultModel: 'mock-l3',
      models: [modelOption('mock', 'mock-l3')],
      hasKey: true,
      isActive: activeProvider === 'mock' || (!activeProvider && activeModel === 'mock-l3'),
      keyEnvVar: '',
      baseUrl: '',
    },
  ];
}

function normalizeHostProvider(provider: HostAiProvider | null | undefined): HostAiProvider {
  if (!provider || typeof provider !== 'object') {
    return createHostManagedProvider({ provider: 'mock', model: 'mock-fallback' });
  }
  const providerName =
    normalizeProviderName(provider.name || provider.provider || provider.type) || 'mock';
  const model =
    typeof provider.model === 'string' && provider.model.length > 0
      ? provider.model
      : defaultModelForProvider(providerName);
  const provided = provider as Partial<HostAiProvider>;
  const executable =
    typeof provided.chat === 'function' ||
    typeof provided.chatWithTools === 'function' ||
    typeof provided.chatWithStructuredOutput === 'function';
  const embedExecutable =
    typeof provided.embed === 'function' ||
    (typeof provided.supportsEmbedding === 'function' && provided.supportsEmbedding());
  const normalizedProvider = provider as HostAiProvider;
  const unavailable = unavailableProviderMethods();
  for (const [key, value] of Object.entries(unavailable)) {
    if (typeof normalizedProvider[key] !== 'function') {
      normalizedProvider[key] = value;
    }
  }
  normalizedProvider.name = providerName;
  normalizedProvider.model = model;
  normalizedProvider.__hostAiExecutable = executable;
  normalizedProvider.__hostEmbedExecutable = embedExecutable;
  return normalizedProvider;
}

function normalizeProviderName(provider: unknown): string | null {
  const normalized = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (!normalized) {
    return null;
  }
  if (normalized === 'google-gemini' || normalized === 'gemini') {
    return 'google';
  }
  if (normalized === 'anthropic') {
    return 'claude';
  }
  return normalized;
}

function defaultModelForProvider(provider: string): string {
  return (
    HOST_PROVIDER_CONFIGS.find((entry) => entry.id === provider)?.defaultModel ||
    (provider === 'mock' ? 'mock-l3' : 'host-managed-model')
  );
}

function hasChatCapability(provider: HostAiProvider | null | undefined): boolean {
  return provider?.__hostAiExecutable === true;
}

function hasEmbeddingCapability(provider: HostAiProvider | null | undefined): boolean {
  return provider?.__hostEmbedExecutable === true;
}

function providerSupportsEmbedding(provider: HostAiProvider | null | undefined): boolean {
  if (!provider) {
    return false;
  }
  return provider.__hostEmbedExecutable === true;
}

function modelOption(provider: string, model: string): HostAiModelOption {
  const contextWindow = contextWindowForModel(model);
  return {
    id: model,
    name: model,
    contextWindow,
    maxOutputTokens: contextWindow >= 200_000 ? 65_536 : 8_192,
    capabilities: {
      streaming: true,
      toolCalling: provider !== 'mock',
      structuredOutput: provider !== 'mock',
      embeddings: provider === 'openai' || provider === 'google' || provider === 'ollama',
    },
    reasoning: {
      supported: /gpt-5|claude|deepseek-v4|gemini-3|gemini-2\.5/i.test(model),
      mode: /gpt-5/i.test(model)
        ? 'reasoning_effort'
        : /claude|deepseek|gemini/i.test(model)
          ? 'thinking'
          : undefined,
      defaultEffort: /gpt-5/i.test(model) ? 'medium' : undefined,
      effortLevels: /gpt-5/i.test(model) ? ['low', 'medium', 'high'] : undefined,
    },
  };
}

function contextWindowForModel(model: string): number {
  if (/gemini|gpt-5\.5|gpt-5\.4|deepseek-v4|claude-(?:opus|sonnet)-4-6/i.test(model)) {
    return 1_000_000;
  }
  if (/gpt-5|claude/i.test(model)) {
    return 200_000;
  }
  if (/llama3\.2|qwen|mistral/i.test(model)) {
    return 128_000;
  }
  if (/mock/i.test(model)) {
    return 32_000;
  }
  return 32_000;
}

function unavailableProviderMethods(): Pick<
  HostAiProvider,
  | 'chat'
  | 'chatWithStructuredOutput'
  | 'chatWithTools'
  | 'embed'
  | 'enrichCandidates'
  | 'probe'
  | 'supportsEmbedding'
> {
  const unavailable = () => {
    throw new Error(
      'AI execution is provided by the host agent and is not bundled in AlembicPlugin.'
    );
  };
  return {
    chat: async () => unavailable(),
    chatWithStructuredOutput: async () => unavailable(),
    chatWithTools: async () => unavailable(),
    embed: async () => unavailable(),
    enrichCandidates: async () => unavailable(),
    probe: async () => unavailable(),
    supportsEmbedding: () => false,
  };
}
