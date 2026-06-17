/**
 * HTTP Server - Alembic 2.0
 * 基于 Express 框架的 REST API 服务器
 * 集成监控、缓存和错误追踪
 */

import { createServer, type Server } from 'node:http';
import Logger from '@alembic/core/logging';
import cors from 'cors';
import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { registerGatewayActions } from '../governance/gateway/GatewayActionRegistry.js';
import { initCacheAdapter } from '../infrastructure/cache/UnifiedCacheAdapter.js';
// RIC-7: monitoring (PerformanceMonitor/ErrorTracker) + realtime (WebSocket) are cut
// from the slimmed embedded daemon HTTP server.
import { getServiceContainer } from '../injection/ServiceContainer.js';
import apiSpec from './api-spec.js';
import { errorHandler } from './middleware/errorHandler.js';
import { gatewayMiddleware } from './middleware/gatewayMiddleware.js';
import { requestLogger } from './middleware/requestLogger.js';
import { sourceResolverMiddleware } from './middleware/sourceResolver.js';
import authRouter from './routes/auth.js';
import daemonRouter from './routes/daemon.js';
import guardRouter from './routes/guard.js';
import healthRouter from './routes/health.js';
import jobsRouter from './routes/jobs.js';
import knowledgeRouter from './routes/knowledge.js';
import modulesRouter from './routes/modules.js';
import searchRouter from './routes/search.js';
import skillsRouter from './routes/skills.js';

interface HttpServerConfig {
  port: number;
  host: string;
  cacheMode: string;
  corsOrigin?: string;
  [key: string]: unknown;
}

/** Type for the winston Logger instance returned by Logger.getInstance() */
type AppLogger = ReturnType<typeof Logger.getInstance>;

export class HttpServer {
  app: Application;
  cacheAdapter: unknown;
  config: HttpServerConfig;
  logger: AppLogger;
  server: Server | null;
  constructor(config: Partial<HttpServerConfig> = {}) {
    this.config = {
      port: config.port ?? 3000,
      host: config.host || 'localhost',
      cacheMode: 'memory',
      ...config,
    } as HttpServerConfig;

    this.logger = Logger.getInstance();
    this.app = express();
    this.server = null;
    this.cacheAdapter = null;
  }

  /** 初始化服务器 */
  async initialize() {
    // 初始化监控和缓存服务
    await this.initializeServices();

    // 注册 Gateway Actions（将 Service 操作绑定到 Gateway 路由）
    this.registerGatewayActions();

    // 中间件
    this.setupMiddleware();

    // 路由
    this.setupRoutes();

    // 错误处理
    this.setupErrorHandling();

    this.logger.info('HTTP Server initialized', {
      port: this.config.port,
      host: this.config.host,
      cacheMode: this.config.cacheMode,
      timestamp: new Date().toISOString(),
    });
  }

  /** 初始化服务（缓存等；RIC-7: 监控已下线） */
  async initializeServices() {
    try {
      // 初始化缓存适配器（纯内存模式）
      this.cacheAdapter = await initCacheAdapter({
        mode: 'memory',
      });
      this.logger.info('Cache adapter initialized');
    } catch (error: unknown) {
      this.logger.error('Failed to initialize services', {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      throw error;
    }
  }

  /** 设置中间件 */
  setupMiddleware() {
    // 安全头（插件 HTTP API 不再打包或服务 Dashboard 前端；这里只保留 API 兼容所需的基础 CSP）
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
            imgSrc: ["'self'", 'data:', 'blob:'],
            connectSrc: ["'self'", 'ws:', 'wss:'],
            fontSrc: ["'self'", 'https:', 'data:'],
            objectSrc: ["'none'"],
            frameSrc: ["'none'"],
          },
        },
      })
    );

    // 请求日志
    this.app.use(requestLogger(this.logger));

    // 解析 JSON 请求体
    this.app.use(express.json({ limit: '10mb' }));

    // 解析 URL 编码的请求体
    this.app.use(express.urlencoded({ limit: '10mb', extended: true }));

    // 跨域处理 (CORS)
    this.app.use(
      cors({
        origin: this.config.corsOrigin || '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: [
          'Origin',
          'X-Requested-With',
          'Content-Type',
          'Accept',
          'Authorization',
          'X-User-Id',
        ],
        credentials: true,
      })
    );

    // 请求来源解析；不使用 git/probe/login 推导运行时权限。
    this.app.use(sourceResolverMiddleware());

    // Gateway 中间件 (注入 req.gw)
    this.app.use(gatewayMiddleware());

    // 请求超时设置（确定性扫描类路由需要更长时间，SSE 流式路由需要更长时间）
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const isLongRunning =
        req.path.includes('/spm/scan') ||
        req.path.includes('/spm/bootstrap') ||
        req.path.includes('/modules/scan') ||
        req.path.includes('/modules/bootstrap');
      const isStreaming = req.path.includes('/stream') || req.path.includes('/events/');
      req.setTimeout(isLongRunning ? 600000 : isStreaming ? 300000 : 60000); // 扫描 10分钟, SSE/EventSource 5分钟, 其他 60秒
      next();
    });
  }

  /** 注册 Gateway Actions */
  registerGatewayActions() {
    try {
      const container = getServiceContainer();
      const gateway = container.get('gateway');
      registerGatewayActions(gateway, container);
      this.logger.info('Gateway actions registered');
    } catch (error: unknown) {
      this.logger.warn('Gateway action registration skipped', {
        error: (error as Error).message,
      });
    }
  }

  /** 设置路由 */
  setupRoutes() {
    // API 版本前缀
    const apiPrefix = '/api/v1';

    // OpenAPI 规范
    this.app.get('/api-spec', (_req: Request, res: Response) => {
      res.json(apiSpec);
    });

    // 健康检查
    this.app.use(`${apiPrefix}/health`, healthRouter);

    // daemon 自检端点（供 DaemonSupervisor 校验 project/data/schema identity）
    this.app.use(`${apiPrefix}/daemon`, daemonRouter);

    // daemon job 状态与投递（Codex 断开后可恢复 job 状态）
    this.app.use(`${apiPrefix}/jobs`, jobsRouter);

    // 认证路由
    this.app.use(`${apiPrefix}/auth`, authRouter);

    // 请求来源探针端点
    this.app.get(`${apiPrefix}/auth/probe`, (req: Request, res: Response) => {
      const source = req.resolvedSource || 'http-request';
      const sourceActor = req.resolvedSourceActor || 'anonymous';
      res.json({
        success: true,
        data: { source, sourceActor, mode: 'source' },
      });
    });

    // Guard 检查路由
    this.app.use(`${apiPrefix}/guard`, guardRouter);

    // 搜索路由
    this.app.use(`${apiPrefix}/search`, searchRouter);

    // Skills 路由
    this.app.use(`${apiPrefix}/skills`, skillsRouter);

    // Modules 路由（v3.2 统一多语言模块扫描；Dashboard scan-stream 消费方）
    this.app.use(`${apiPrefix}/modules`, modulesRouter);

    // 知识条目路由 (V3)
    this.app.use(`${apiPrefix}/knowledge`, knowledgeRouter);

    // Panorama / evolution HTTP read surfaces removed in 0.3.0 (A3 ruling,
    // r-group-rulings 2026-06-13): these were byte-identical twins of the
    // main Alembic daemon routes (contract-mounted there, I22) with no plugin
    // consumer — the Dashboard reaches the main daemon. The MCP alembic_panorama
    // tool and the PanoramaService capability stay; only the dead HTTP read
    // surfaces are gone. Git-recoverable; see docs/legacy-register.md D-row.

    // 根路径 — 返回 API 元信息（避免外部探测产生无意义 404）
    this.app.all('/', (_req: Request, res: Response) => {
      res.json({
        name: 'Alembic API',
        version: '2.0',
        docs: '/api-spec',
        health: `${apiPrefix}/health`,
      });
    });

    // 404 处理（使用 app.all 确保 layer.route 存在）
    this.app.all('{*path}', (req: Request, res: Response) => {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Route not found: ${req.method} ${req.originalUrl}`,
        },
      });
    });
  }

  /** 设置错误处理 */
  setupErrorHandling() {
    // RIC-7: ErrorTracker is cut from the slimmed daemon; use the global error handler.
    this.app.use(errorHandler(this.logger));
  }

  /** 启动服务器 */
  async start() {
    const { promise, resolve, reject } = Promise.withResolvers<Server>();
    try {
      this.server = createServer(this.app);
      let settled = false;

      const onError = (error: NodeJS.ErrnoException) => {
        settled = this.handleStartError(error, settled, reject);
      };

      const onListening = () => {
        const activeServer = this.handleStartListening(onError, reject);
        if (activeServer) {
          settled = true;
          resolve(activeServer);
        }
      };

      this.server.on('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.config.port, this.config.host);
    } catch (error: unknown) {
      this.logger.error('Failed to start HTTP Server', {
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
      reject(error);
    }
    return promise;
  }

  private handleStartError(
    error: NodeJS.ErrnoException,
    settled: boolean,
    reject: (reason?: unknown) => void
  ) {
    this.logger.error('HTTP Server error', {
      error: error.message,
      code: error.code,
      timestamp: new Date().toISOString(),
    });
    if (settled) {
      return true;
    }
    this.server = null;
    reject(error);
    return true;
  }

  private handleStartListening(
    onError: (error: NodeJS.ErrnoException) => void,
    reject: (reason?: unknown) => void
  ) {
    const address = this.server?.address();
    if (!address || typeof address !== 'object' || address.port <= 0) {
      const error = new Error(
        `HTTP Server did not bind to a valid port: ${JSON.stringify(address)}`
      );
      onError(error as NodeJS.ErrnoException);
      return null;
    }
    this.config.port = address.port;
    this.logger.info('HTTP Server started', {
      host: this.config.host,
      port: this.config.port,
      url: `http://${this.config.host}:${this.config.port}`,
      timestamp: new Date().toISOString(),
    });

    const activeServer = this.server;
    if (!activeServer) {
      reject(new Error('HTTP server failed to initialize'));
      return null;
    }
    return activeServer;
  }

  /** 停止服务器 */
  async stop() {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    if (!this.server) {
      return resolve(undefined);
    }

    this.server.close((error) => {
      if (error) {
        this.logger.error('Error stopping HTTP Server', {
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return reject(error);
      }

      this.logger.info('HTTP Server stopped', {
        timestamp: new Date().toISOString(),
      });
      resolve(undefined);
    });
    return promise;
  }

  /** 获取 Express 应用实例 */
  getApp() {
    return this.app;
  }

  /** 获取服务器实例 */
  getServer() {
    return this.server;
  }
}

export default HttpServer;
