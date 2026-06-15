// ─── v3.1: Multi-Language Discovery + Enhancement ────────
import { initEnhancementRegistry } from '@alembic/core/core/enhancement';
// ─── P3: Infrastructure ──────────────────────────────
import Logger from '@alembic/core/logging';
import { unwrapRawDb } from '@alembic/core/search';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { CacheCoordinator } from '../infrastructure/cache/CacheCoordinator.js';
import * as AppModule from './modules/AppModule.js';
import * as GuardModule from './modules/GuardModule.js';
// ─── DI Modules ──────────────────────────────────────
import * as InfraModule from './modules/InfraModule.js';
import * as KnowledgeModule from './modules/KnowledgeModule.js';
import * as SignalModule from './modules/SignalModule.js';
import * as SkillHooksModule from './modules/SkillHooksModule.js';
import * as VectorModule from './modules/VectorModule.js';
import type { ServiceMap } from './ServiceMap.js';
/**
 * DependencyInjection 容器
 * 管理所有应用层的仓储、服务和基础设施依赖的创建和注入
 */
export class ServiceContainer {
  logger: ReturnType<typeof Logger.getInstance>;
  services: Record<string, () => unknown>;
  singletons: Record<string, unknown>;
  constructor() {
    this.services = {};
    this.singletons = {};
    this.logger = Logger.getInstance();
  }

  // ─── 通用注册方法 ──────────────────────────────────

  /**
   * 注册一个惰性单例服务 — 消除 `if (!this.singletons.xxx)` 样板代码
   *
   * @param name 服务名称
   * @param factory 工厂函数（首次 get 时执行）
   */
  singleton(
    name: string,
    factory: (container: ServiceContainer) => unknown,
    _options: Record<string, never> = {}
  ) {
    this.register(name, () => {
      if (!this.singletons[name]) {
        this.singletons[name] = factory(this);
      }
      return this.singletons[name];
    });
  }

  /** 静态单例获取（路由层使用） */
  static getInstance() {
    return getServiceContainer();
  }

  /**
   * 初始化所有服务和仓储
   * @param bootstrapComponents Bootstrap 初始化的组件（db, auditLogger, gateway 等）
   */
  async initialize(bootstrapComponents: Record<string, unknown> = {}) {
    try {
      // ── 多项目防护：禁止同一进程内切换项目 ──
      const newRoot = bootstrapComponents.projectRoot as string | undefined;
      const existingRoot = this.singletons._projectRoot as string | undefined;
      if (newRoot && existingRoot && newRoot !== existingRoot) {
        throw new Error(
          `[ServiceContainer] 不允许在同一进程中切换项目。` +
            `当前绑定: ${existingRoot}, 请求: ${newRoot}。` +
            `请为每个项目启动独立进程。`
        );
      }

      // 如果提供了 bootstrap 组件，将它们注入到单例缓存中
      if (bootstrapComponents.db) {
        this.singletons.database = bootstrapComponents.db;
      }
      if (bootstrapComponents.auditLogger) {
        this.singletons.auditLogger = bootstrapComponents.auditLogger;
      }
      if (bootstrapComponents.gateway) {
        this.singletons.gateway = bootstrapComponents.gateway;
      }

      if (bootstrapComponents.projectRoot) {
        this.singletons._projectRoot = bootstrapComponents.projectRoot;
      }

      if (bootstrapComponents.workspaceResolver) {
        this.singletons._workspaceResolver = bootstrapComponents.workspaceResolver;
      }

      if (bootstrapComponents.config) {
        this.singletons._config = bootstrapComponents.config;
      }

      if (bootstrapComponents.skillHooks) {
        this.singletons.skillHooks = bootstrapComponents.skillHooks;
      }

      // RecipeExtractor 实例（用于工具增强）
      AppModule.initRecipeExtractor(this);

      // 注册所有模块 (替代 _registerInfrastructure / _registerRepositories / _registerServices)
      InfraModule.register(this);

      // ═══ 容器级语言偏好 ═══
      this.singletons._lang = null;

      // 注册模块 (顺序重要: AppModule 先注册 qualityScorer 等基础服务)
      // SignalModule 优先注册并预热，确保后续模块可访问 signalBus
      SignalModule.register(this);
      this.get('signalBus'); // eager: 确保 singletons.signalBus 在后续工厂可用
      AppModule.register(this);
      KnowledgeModule.register(this);
      VectorModule.register(this);
      GuardModule.register(this);
      SkillHooksModule.register(this);

      // v3.1: 初始化 Enhancement Pack 注册表（异步加载所有框架增强包）
      try {
        await initEnhancementRegistry();
      } catch (e: unknown) {
        this.logger.warn('Enhancement registry init failed (non-blocking)', {
          error: (e as Error).message,
        });
      }

      // v3.3: 初始化 VectorService（绑定 EventBus 事件监听）
      await VectorModule.initializeVectorService(this);

      // v3.4: 初始化 Knowledge 服务（绑定 EventBus → SearchEngine.refreshIndex + sourceRefs）
      KnowledgeModule.initializeKnowledgeServices(this);

      // v3.5: 跨进程缓存协调器（利用 SQLite PRAGMA data_version 检测其他进程写入）
      this.#initCacheCoordinator();

      this.logger.info('Service container initialized successfully');
    } catch (error: unknown) {
      this.logger.error('Error initializing service container', {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  // ─── 跨进程缓存协调 ─────

  /**
   * 初始化 CacheCoordinator：当其他进程写入 DB 后，自动清除本进程的内存缓存。
   *
   * 订阅的服务：
   *   - guardCheckEngine: clearCache() — 规则缓存
   *   - searchEngine: buildIndex() — 搜索索引
   *
   * 仅在长驻进程（HTTP server / MCP server）中自动启动轮询。
   * 其他短生命周期调用无需启动（进程生命周期短，缓存不会过时）。
   */
  #initCacheCoordinator(): void {
    try {
      const db = this.singletons.database as
        | {
            getDb?: () => import('@alembic/core/database').SqliteDatabase;
          }
        | undefined;
      const rawDb = db
        ? (unwrapRawDb(db as unknown) as import('@alembic/core/database').SqliteDatabase | null)
        : null;
      if (!rawDb) {
        return;
      }

      const coordinator = new CacheCoordinator(rawDb);
      this.singletons.cacheCoordinator = coordinator;
      this.register('cacheCoordinator', () => coordinator);

      // 懒订阅：仅在对应服务已初始化时绑定
      coordinator.subscribe('guardCheckEngine', () => {
        const svc = this.singletons.guardCheckEngine as { clearCache?: () => void } | undefined;
        svc?.clearCache?.();
      });

      coordinator.subscribe('searchEngine', () => {
        const svc = this.singletons.searchEngine as { buildIndex?: () => void } | undefined;
        svc?.buildIndex?.();
      });

      // 长驻进程自动启动轮询
      const isMcp = process.env.ALEMBIC_MCP_MODE === '1';
      const isApiServer = process.env.ALEMBIC_API_SERVER === '1';
      if (isMcp || isApiServer) {
        coordinator.start();
      }

      this.logger.info('CacheCoordinator initialized', {
        subscribers: coordinator.subscriberCount,
        polling: isMcp || isApiServer,
      });
    } catch (err: unknown) {
      this.logger.warn('CacheCoordinator init failed (non-blocking)', {
        error: (err as Error).message,
      });
    }
  }

  // ─── 容器级语言偏好 ─────

  /** 获取当前默认 UI 语言偏好 */
  getLang() {
    return this.singletons._lang || null;
  }

  /** 设置默认 UI 语言偏好（影响 Agent 回复语言） */
  setLang(lang: 'zh' | 'en' | null) {
    this.singletons._lang = lang || null;
  }

  // ─── 工具执行上下文构建器 ─────────────────────

  /**
   * 构建 internal tool handler 所需的 legacy context projection。
   *
   * Router/Adapter 路径会将其折叠到 InternalToolHandlerContext；旧 fallback
   * 调用方仍可在迁移期间复用同一上下文来源。
   */
  buildToolContext(extras: Record<string, unknown> = {}): Record<string, unknown> {
    const projectRoot = resolveProjectRoot(this);
    return {
      container: this,
      projectRoot,
      dataRoot: resolveDataRoot(this) || projectRoot,
      logger: this.logger,
      source: extras.source || 'system',
      lang: extras.lang || this.singletons._lang || null,
      fileCache: this.singletons._fileCache || null,
      ...extras,
    };
  }

  /** 注册服务或工厂函数 */
  register(name: string, factory: () => unknown) {
    if (this.services[name] && process.env.NODE_ENV !== 'production') {
      this.logger.warn(`[ServiceContainer] 服务 "${name}" 被重复注册，前一个工厂将被覆盖`);
    }
    this.services[name] = factory;
  }

  /**
   * 获取服务（类型安全版本）
   *
   * 当传入 ServiceMap 中已知的 key 时，自动推导返回类型：
   * ```ts
   * const search = container.get('searchEngine'); // SearchEngine
   * const guard = container.get('guardService');   // GuardService
   * ```
   *
   * 对于非 ServiceMap 中的 key，返回 unknown（向后兼容）。
   */
  get<K extends keyof ServiceMap>(name: K): ServiceMap[K];
  get(name: string): unknown;
  get(name: string): unknown {
    if (!this.services[name]) {
      throw new Error(`Service '${name}' not found in container`);
    }
    return this.services[name]();
  }

  /** 清除所有单例（用于测试） */
  reset() {
    this.singletons = {};
  }

  /** 获取所有已注册的服务名 */
  getServiceNames() {
    return Object.keys(this.services);
  }

}

let containerInstance: ServiceContainer | null = null;

/** 获取全局服务容器实例 */
export function getServiceContainer() {
  if (!containerInstance) {
    containerInstance = new ServiceContainer();
  }
  return containerInstance;
}

/** 重置全局服务容器（主要用于测试） */
export function resetServiceContainer() {
  if (containerInstance) {
    containerInstance.reset();
  }
  containerInstance = null;
}

export default ServiceContainer;
