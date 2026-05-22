import type { DaemonState } from '@alembic/core/daemon';
import { extractResponseError, failureResult } from './results.js';

// Daemon job API 是增强路径；失败结果保持 MCP 结构，调用方可回退本地 JobStore。
export async function callDaemonHttpEndpoint(
  state: DaemonState,
  path: string,
  request: { body?: Record<string, unknown>; method: 'GET' | 'POST' },
  tool: string
): Promise<unknown> {
  const response = await fetch(`${state.url}${path}`, {
    method: request.method,
    headers: {
      'content-type': 'application/json',
      'x-alembic-daemon-token': state.token || '',
    },
    body: request.body ? JSON.stringify(request.body) : undefined,
  });

  const payload = await readJsonResponse(response);
  if (response.ok) {
    return payload;
  }
  return failureResult(
    tool,
    extractResponseError(payload) || `Daemon job API returned ${response.status}`,
    {
      daemon: {
        url: state.url,
        pid: state.pid,
        port: state.port,
      },
      response: payload,
    }
  );
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { success: false, message: text };
  }
}

export function buildJobQuery(args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  if (args.kind === 'bootstrap' || args.kind === 'rescan') {
    params.set('kind', args.kind);
  }
  if (
    args.status === 'queued' ||
    args.status === 'running' ||
    args.status === 'completed' ||
    args.status === 'failed' ||
    args.status === 'cancelled'
  ) {
    params.set('status', args.status);
  }
  if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
    params.set('limit', String(args.limit));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}
