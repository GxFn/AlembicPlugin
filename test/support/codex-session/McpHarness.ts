import { getVisibleCodexTools, HostMcpServer } from '../../../lib/runtime/mcp/HostMcpServer.js';
import type {
  CodexScenarioToolCallFact,
  CodexSessionHarnessMode,
  CodexSessionScenario,
  CodexSessionTranscriptEvent,
} from './ScenarioTypes.js';
import type { TranscriptWriter } from './TranscriptWriter.js';

export interface CodexMcpHarnessContext {
  mode: CodexSessionHarnessMode;
  projectRoot: string;
  scenario: CodexSessionScenario;
  transcript: TranscriptWriter;
  waitUntilReadyMs?: number;
}

// PDR-3: the embedded daemon and its supervisor were removed. HostMcpServer no
// longer accepts a supervisor; the harness drives the daemon-less MCP surface
// directly. The old FakeDaemonSupervisor/RecordingDaemonSupervisor recorders and
// the supervisor field are gone with the daemon carrier.
export interface AlembicMcpHarness {
  readonly fetchCalls: Array<{ body: unknown; url: string }>;
  readonly toolCalls: CodexScenarioToolCallFact[];
  readonly transcript: TranscriptWriter;
  callTool(turn: number, name: string, args?: Record<string, unknown>): Promise<unknown>;
  listTools(): Array<{ name: string }>;
  restore(): void;
}

export class AlembicInProcessMcpHarness implements AlembicMcpHarness {
  readonly fetchCalls: Array<{ body: unknown; url: string }> = [];
  readonly toolCalls: CodexScenarioToolCallFact[] = [];
  readonly transcript: TranscriptWriter;
  #originalFetch: typeof globalThis.fetch;
  #server: HostMcpServer;

  constructor(context: CodexMcpHarnessContext) {
    this.transcript = context.transcript;
    this.#server = new HostMcpServer();
    this.#originalFetch = globalThis.fetch;
    this.#installFetchMock();
  }

  async callTool(turn: number, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.transcript.record({
      data: { arguments: args },
      tool: name,
      turn,
      type: 'codex.tool_call',
    });
    const result = await this.#server.handleToolCall(name, args);
    const success =
      typeof result === 'object' && result !== null && 'success' in result
        ? Boolean((result as { success?: unknown }).success)
        : null;
    const errorCode = extractErrorCode(result);
    this.toolCalls.push({ arguments: args, errorCode, name, result, success, turn });
    this.transcript.record({
      data: normalizeResult(result),
      tool: name,
      turn,
      type: 'tool.result',
    });
    return result;
  }

  listTools(): Array<{ name: string }> {
    return getVisibleCodexTools().map((tool) => ({ name: tool.name }));
  }

  restore(): void {
    globalThis.fetch = this.#originalFetch;
  }

  #installFetchMock(): void {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const body = parseJsonBody(init?.body);
      this.fetchCalls.push({ body, url });
      if (url.includes('/api/v1/jobs/bootstrap')) {
        return jsonResponse(202, {
          success: true,
          data: {
            jobId: 'scenario_bootstrap_job',
            job: { id: 'scenario_bootstrap_job', kind: 'bootstrap' },
          },
        });
      }
      if (url.includes('/api/v1/jobs/rescan')) {
        return jsonResponse(202, {
          success: true,
          data: {
            jobId: 'scenario_rescan_job',
            job: { id: 'scenario_rescan_job', kind: 'rescan' },
          },
        });
      }
      if (url.includes('/api/v1/jobs')) {
        return jsonResponse(200, { success: true, data: { jobs: [] } });
      }
      return jsonResponse(404, { success: false, message: `Unhandled scenario fetch: ${url}` });
    };
  }
}

export class AlembicLiveLocalMcpHarness implements AlembicMcpHarness {
  readonly fetchCalls: Array<{ body: unknown; url: string }> = [];
  readonly toolCalls: CodexScenarioToolCallFact[] = [];
  readonly transcript: TranscriptWriter;
  #originalFetch: typeof globalThis.fetch;
  #server: HostMcpServer;

  constructor(context: CodexMcpHarnessContext) {
    this.transcript = context.transcript;
    this.#server = new HostMcpServer({
      waitUntilReadyMs: context.waitUntilReadyMs,
    });
    this.#originalFetch = globalThis.fetch;
    this.#installFetchRecorder();
  }

  async callTool(turn: number, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.transcript.record({
      data: { arguments: args },
      tool: name,
      turn,
      type: 'codex.tool_call',
    });
    const result = await this.#server.handleToolCall(name, args);
    const success =
      typeof result === 'object' && result !== null && 'success' in result
        ? Boolean((result as { success?: unknown }).success)
        : null;
    const errorCode = extractErrorCode(result);
    this.toolCalls.push({ arguments: args, errorCode, name, result, success, turn });
    this.transcript.record({
      data: normalizeResult(result),
      tool: name,
      turn,
      type: 'tool.result',
    });
    return result;
  }

  listTools(): Array<{ name: string }> {
    return getVisibleCodexTools().map((tool) => ({ name: tool.name }));
  }

  restore(): void {
    globalThis.fetch = this.#originalFetch;
  }

  #installFetchRecorder(): void {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const body = parseJsonBody(init?.body);
      this.fetchCalls.push({ body, url });
      return this.#originalFetch(input, init);
    };
  }
}

export function createCodexMcpHarness(context: CodexMcpHarnessContext): AlembicMcpHarness {
  if (context.mode === 'live-local') {
    return new AlembicLiveLocalMcpHarness(context);
  }
  return new AlembicInProcessMcpHarness(context);
}

function extractErrorCode(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }
  const data = (result as { data?: unknown }).data;
  if (
    data &&
    typeof data === 'object' &&
    typeof (data as { errorCode?: unknown }).errorCode === 'string'
  ) {
    return (data as { errorCode: string }).errorCode;
  }
  if (typeof (result as { errorCode?: unknown }).errorCode === 'string') {
    return (result as { errorCode: string }).errorCode;
  }
  return undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function normalizeResult(result: unknown): Record<string, unknown> {
  return result && typeof result === 'object'
    ? (result as Record<string, unknown>)
    : { value: result };
}

function parseJsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') {
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function transcriptEvent(
  type: string,
  data: Record<string, unknown> = {}
): CodexSessionTranscriptEvent {
  return { data, type };
}
