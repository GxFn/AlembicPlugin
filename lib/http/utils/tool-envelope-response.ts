import type { Response } from 'express';

export type HttpToolResultStatus =
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'needs-confirmation'
  | 'success'
  | 'timeout';

export interface HttpToolResultEnvelope {
  callId: string;
  diagnostics?: unknown;
  ok: boolean;
  status: HttpToolResultStatus;
  text: string;
  toolId: string;
  [key: string]: unknown;
}

export function httpStatusForToolEnvelope(status: HttpToolResultStatus) {
  switch (status) {
    case 'blocked':
      return 403;
    case 'needs-confirmation':
      return 409;
    case 'timeout':
      return 504;
    case 'aborted':
      return 499;
    case 'error':
      return 500;
    case 'success':
      return 200;
  }
}

export function sendToolEnvelopeResponse(res: Response, envelope: HttpToolResultEnvelope) {
  if (envelope.ok) {
    res.json({ success: true, data: envelope });
    return;
  }

  res.status(httpStatusForToolEnvelope(envelope.status)).json({
    success: false,
    error: {
      code: `TOOL_${envelope.status.toUpperCase().replaceAll('-', '_')}`,
      message: envelope.text,
      toolId: envelope.toolId,
      callId: envelope.callId,
      status: envelope.status,
      diagnostics: envelope.diagnostics,
    },
    data: envelope,
  });
}
