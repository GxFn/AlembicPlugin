export interface UnifiedMessage {
  role: 'assistant' | 'system' | 'tool' | 'user';
  content?: string | null;
  name?: string;
  reasoningContent?: string | null;
  toolCallId?: string;
  toolCalls?: Array<{
    args?: Record<string, unknown>;
    id: string;
    name: string;
    thoughtSignature?: string;
  }>;
  [key: string]: unknown;
}

export interface ToolSchema {
  description?: string;
  name: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ChatWithToolsResult {
  functionCalls?: Array<{
    args: Record<string, unknown>;
    id: string;
    name: string;
    thoughtSignature?: string;
  }> | null;
  reasoningContent?: string | null;
  text?: string | null;
  type?: string;
  usage?: {
    cacheHitTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
  };
}

export interface RuntimeAiProvider {
  name: string;
  model: string;
  _circuitState?: string;
  chat?: (prompt: string, options?: Record<string, unknown>) => Promise<string>;
  chatWithStructuredOutput?: (
    prompt: string,
    options?: Record<string, unknown>
  ) => Promise<unknown>;
  chatWithTools: (
    prompt: string,
    options?: Record<string, unknown>
  ) => Promise<ChatWithToolsResult>;
}

export interface RuntimeLlmBridge {
  chatWithTools(request: {
    abortSignal?: AbortSignal;
    maxTokens?: number;
    messages: UnifiedMessage[];
    modelRef: string;
    systemPrompt?: string;
    temperature?: number;
    toolChoice?: string;
    tools?: ToolSchema[];
  }): Promise<ChatWithToolsResult>;
}
