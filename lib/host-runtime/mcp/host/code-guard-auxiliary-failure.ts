export function attachCodeGuardAuxiliaryFailure(input: {
  diagnosticCode: string;
  message: string;
  result: unknown;
}): unknown {
  if (!isRecord(input.result)) {
    return input.result;
  }
  const detail = boundedText(input.message, 420);
  const existingDiagnostics = Array.isArray(input.result.diagnostics)
    ? input.result.diagnostics
    : [];
  const promotesReadyResult = input.result.status === 'ready';
  return {
    ...input.result,
    ...(promotesReadyResult
      ? {
          status: 'degraded',
          reason: {
            kind: 'degraded',
            code: 'optional-service-unavailable',
            message: boundedText(
              `Code Guard verdict is preserved, but an auxiliary request-scoped operation failed: ${detail}`,
              600
            ),
            retryable: true,
          },
        }
      : {}),
    diagnostics: [
      ...existingDiagnostics,
      {
        code: input.diagnosticCode,
        severity: 'error',
        message: detail,
        retryable: true,
      },
    ],
  };
}

export function auxiliaryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedText(value: string, maxLength: number): string {
  const normalized = value.trim() || 'Unknown request-scoped auxiliary operation failure.';
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
