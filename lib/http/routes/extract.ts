/**
 * Extract API 路由
 * 从路径或文本提取 Recipe 候选
 */

import Logger from '@alembic/core/logging';
import express, { type Request, type Response } from 'express';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { ExtractPathBody, ExtractTextBody } from '../../shared/schemas/http-requests.js';
import { validate } from '../middleware/validate.js';
import { attachPluginDeterministicBoundary } from '../utils/host-managed-boundary.js';

const router = express.Router();
const logger = Logger.getInstance();

/**
 * POST /api/v1/extract/path
 * 从文件路径提取代码片段
 * 管线: RecipeParser(MD解析) → 原始兜底
 */
router.post(
  '/path',
  validate(ExtractPathBody),
  async (req: Request, res: Response): Promise<void> => {
    const { relativePath, projectRoot: bodyRoot } = req.body;

    const container = getServiceContainer();
    const recipeParser = container.get('recipeParser');

    // 优先用请求体的 projectRoot，其次用 ServiceContainer 中注册的全局值
    const projectRoot = bodyRoot || container.singletons?._projectRoot || process.cwd();
    logger.debug('extract/path: resolved projectRoot', {
      relativePath,
      projectRoot,
      source: bodyRoot ? 'body' : container.singletons?._projectRoot ? 'container' : 'cwd',
    });

    // 1. RecipeParser 解析（对 Recipe MD 文件有效）
    const result = await recipeParser.extractFromPath(relativePath, {
      projectRoot,
    });

    const items = result.items || result;

    // 2. 返回 RecipeParser 结果（MD 文件或原始兜底）
    res.json({
      success: true,
      data: attachPluginDeterministicBoundary(
        {
          result: items,
          isMarked: result.isMarked || false,
        },
        'extract-path'
      ),
    });
  }
);

/**
 * POST /api/v1/extract/text
 * 从文本内容提取代码片段（剪贴板等）
 * 管线: RecipeParser(MD解析) → 基础兜底
 */
router.post(
  '/text',
  validate(ExtractTextBody),
  async (req: Request, res: Response): Promise<void> => {
    const { text, language, relativePath } = req.body;

    const container = getServiceContainer();
    const recipeParser = container.get('recipeParser');

    // 1. 先尝试解析为 Recipe Markdown 格式
    let result: unknown;
    try {
      result = await recipeParser.parseFromText(text, {
        language,
        relativePath,
      });
      // 解析成功，直接返回
      return void res.json({
        success: true,
        data: attachPluginDeterministicBoundary(
          {
            result: Array.isArray(result) ? result : [result],
            source: 'text',
          },
          'extract-text-markdown'
        ),
      });
    } catch (error: unknown) {
      logger.debug('Recipe MD parse failed, using basic fallback', {
        error: (error as Error).message,
      });
    }

    // 2. Recipe MD 解析失败 → 基础代码块提取兜底
    result = await recipeParser.extractFromText(text, { language });

    res.json({
      success: true,
      data: attachPluginDeterministicBoundary(
        {
          result: Array.isArray(result) ? result : [result],
          source: 'text',
          relativePath,
        },
        'extract-text-basic'
      ),
    });
  }
);

export default router;
