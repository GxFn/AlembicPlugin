import { HOST_NEUTRAL_INTERNAL_ERROR_CODE, normalizeHostMcpErrorCode } from '../error-taxonomy.js';

export interface FailureResultOptions {
  code?: string;
  data?: Record<string, unknown>;
}

// Shared Host MCP helper: one authoritative top-level code, with business data
// kept separate so projectors never have to choose between competing codes.
export function failureResult(
  tool: string,
  message: string,
  options: FailureResultOptions = {}
): Record<string, unknown> {
  return {
    success: false,
    message,
    errorCode: normalizeHostMcpErrorCode(options.code ?? HOST_NEUTRAL_INTERNAL_ERROR_CODE),
    tool,
    data: options.data ?? {},
  };
}

export function isErrorResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const value = result as { ok?: unknown; success?: unknown; isError?: unknown };
  return value.ok === false || value.success === false || value.isError === true;
}
