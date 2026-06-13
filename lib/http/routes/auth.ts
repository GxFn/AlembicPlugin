/**
 * Auth routes are retained only as explicit compatibility tombstones.
 *
 * AlembicPlugin has no login-backed developer/admin runtime role model.
 * Operation-specific entrypoints and Codex MCP tool policy own their checks.
 */

import express, { type Request, type Response } from 'express';
import { AuthLoginBody } from '../../shared/schemas/http-requests.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

function retiredAuthResponse(_req: Request, res: Response): void {
  res.status(410).json({
    success: false,
    error: {
      code: 'AUTH_MODEL_RETIRED',
      message: 'AlembicPlugin does not use login or developer/admin runtime roles.',
    },
  });
}

router.post('/login', validate(AuthLoginBody), retiredAuthResponse);
router.get('/me', retiredAuthResponse);

export default router;
