/**
 * Recipes API routes.
 *
 * Recipe CRUD lives in the knowledge routes. AlembicPlugin no longer runs
 * local Agent/AI relation discovery; the compatibility route fails closed.
 */

import express, { type Request, type Response } from 'express';

const router = express.Router();

let discoverTask: Record<string, unknown> = {
  status: 'unavailable',
  startedAt: null,
  finishedAt: null,
  discovered: 0,
  totalPairs: 0,
  batchErrors: 0,
  error: null,
  elapsed: 0,
  message: 'AlembicPlugin 不再执行本地 AI 关系发现；请由宿主 agent 或 Core 外部编排提交关系。',
  hostManaged: true,
};

router.post('/discover-relations', async (_req: Request, res: Response): Promise<void> => {
  discoverTask = {
    ...discoverTask,
    status: 'unavailable',
    startedAt: null,
    finishedAt: new Date().toISOString(),
    elapsed: 0,
  };

  res.status(501).json({
    success: false,
    error: {
      code: 'HOST_AI_MANAGED',
      message: 'Recipe 关系发现已从 AlembicPlugin 删除；请由宿主 agent 或 Core 外部编排提交关系。',
    },
    data: discoverTask,
  });
});

router.get('/discover-relations/status', async (_req: Request, res: Response) => {
  res.json({ success: true, data: discoverTask });
});

export default router;
