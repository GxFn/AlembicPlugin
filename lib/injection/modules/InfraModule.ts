/**
 * InfraModule — 基础设施 + 仓储注册
 *
 * 负责注册:
 *   - database, logger, auditStore, auditLogger
 *   - eventBus, bootstrapTaskManager
 *   - knowledgeRepository, knowledgeFileWriter, knowledgeSyncService
 */

import path from 'node:path';
import { JobStore } from '@alembic/core/daemon';
import { EventBus } from '@alembic/core/events';
import { ReportStore } from '@alembic/core/infrastructure/report';
import { WriteZone } from '@alembic/core/io';
import {
  KnowledgeFileWriter,
  KnowledgeSyncService,
  type SourceRefReconciler,
} from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { MemoryRepositoryImpl } from '@alembic/core/memory';
import {
  type AlembicRepositoryBundle,
  createAlembicRepositories,
} from '@alembic/core/repositories';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { BootstrapTaskManager } from '#recipe-generation/bootstrap/BootstrapTaskManager.js';
import AuditLogger from '../../infrastructure/audit/AuditLogger.js';
import AuditStore from '../../infrastructure/audit/AuditStore.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  registerInfrastructure(c);
  registerWriteZone(c);
  registerRepositories(c);
  registerKnowledgeSync(c);
  registerReportStore(c);
}

function registerInfrastructure(c: ServiceContainer) {
  // ═══ Infrastructure ═══

  c.register('database', () => {
    if (!c.singletons.database) {
      throw new Error(
        'Database not initialized. Ensure Bootstrap.initialize() is called before using ServiceContainer.'
      );
    }
    return c.singletons.database;
  });

  c.register('logger', () => Logger.getInstance());

  c.singleton('auditStore', (ct: ServiceContainer) => {
    const db = ct.get('database') as ConstructorParameters<typeof AuditStore>[0];
    const drizzle = (db as unknown as { getDrizzle(): unknown }).getDrizzle();
    return new AuditStore(db, drizzle as ConstructorParameters<typeof AuditStore>[1]);
  });
  c.singleton(
    'auditLogger',
    (ct: ServiceContainer) =>
      new AuditLogger(
        ct.get('auditStore') as ConstructorParameters<typeof AuditLogger>[0],
        ct.services.eventBus
          ? (ct.get('eventBus') as ConstructorParameters<typeof AuditLogger>[1])
          : null
      )
  );
  c.singleton('eventBus', () => new EventBus({ maxListeners: 30 }));

  c.singleton('bootstrapTaskManager', (ct: ServiceContainer) => {
    const eventBus = ct.get('eventBus');
    // RIC-7: RealtimeService (WebSocket) is cut from the slimmed daemon; progress
    // still flows via EventBus. BootstrapTaskManager's realtime getter is left unset.
    return new BootstrapTaskManager({
      eventBus,
    } as ConstructorParameters<typeof BootstrapTaskManager>[0]);
  });

  c.singleton('jobStore', (ct: ServiceContainer) => {
    return new JobStore({ projectRoot: resolveProjectRoot(ct) });
  });
}

function registerWriteZone(c: ServiceContainer) {
  // ═══ WriteZone ═══

  c.singleton('writeZone', (ct: ServiceContainer) => {
    const resolver = ct.singletons._workspaceResolver as
      | import('@alembic/core/workspace').WorkspaceResolver
      | undefined;
    if (!resolver) {
      return null;
    }
    return new WriteZone(resolver);
  });
}

function registerRepositories(c: ServiceContainer) {
  // ═══ Repositories ═══

  c.singleton('knowledgeRepository', (ct: ServiceContainer) => {
    return getCoreRepositories(ct).knowledgeRepository;
  });

  c.singleton('knowledgeEdgeRepository', (ct: ServiceContainer) => {
    return getCoreRepositories(ct).knowledgeEdgeRepository;
  });

  c.singleton('codeEntityRepository', (ct: ServiceContainer) => {
    return getCoreRepositories(ct).codeEntityRepository;
  });

  c.singleton('bootstrapRepository', (ct: ServiceContainer) => {
    return getCoreRepositories(ct).bootstrapRepository;
  });

  c.singleton('guardViolationRepository', (ct: ServiceContainer) => {
    return getCoreRepositories(ct).guardViolationRepository;
  });

  c.singleton('memoryRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    const drizzle = db.getDrizzle();
    return new MemoryRepositoryImpl(
      drizzle as ConstructorParameters<typeof MemoryRepositoryImpl>[0]
    );
  });

  c.singleton('sessionRepository', (ct: ServiceContainer) => {
    return getCoreRepositories(ct).sessionRepository;
  });

  c.singleton('proposalRepository', (ct: ServiceContainer) => {
    return getCoreRepositories(ct).proposalRepository;
  });

  c.singleton('warningRepository', (ct: ServiceContainer) => {
    return getCoreRepositories(ct).warningRepository;
  });

  c.singleton('lifecycleEventRepository', (ct: ServiceContainer) => {
    return getCoreRepositories(ct).lifecycleEventRepository;
  });

  c.singleton('recipeSourceRefRepository', (ct: ServiceContainer) => {
    return getCoreRepositories(ct).recipeSourceRefRepository;
  });

  c.singleton('planRepository', (ct: ServiceContainer) => {
    return getCoreRepositories(ct).planRepository;
  });
}

function registerKnowledgeSync(c: ServiceContainer) {
  // ═══ Knowledge Sync ═══

  c.singleton('knowledgeFileWriter', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const wz = ct.singletons.writeZone as import('@alembic/core/io').WriteZone | undefined;
    return new KnowledgeFileWriter(dataRoot, wz);
  });

  c.singleton('knowledgeSyncService', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const sourceRefReconciler = getSourceRefReconciler(ct);
    return new KnowledgeSyncService(dataRoot, {
      sourceRefReconciler: sourceRefReconciler || undefined,
    });
  });
}

function getSourceRefReconciler(ct: ServiceContainer): SourceRefReconciler | undefined {
  return ct.services.sourceRefReconciler
    ? (ct.get('sourceRefReconciler') as SourceRefReconciler)
    : undefined;
}

function registerReportStore(c: ServiceContainer) {
  // ═══ ReportStore ═══

  c.singleton('reportStore', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const wz = ct.get('writeZone') as WriteZone | null;
    return new ReportStore(path.join(dataRoot, '.asd', 'logs', 'reports'), wz ?? undefined);
  });
}

function getCoreRepositories(ct: ServiceContainer): AlembicRepositoryBundle {
  const cached = ct.singletons.coreRepositories as AlembicRepositoryBundle | undefined;
  if (cached) {
    return cached;
  }

  const repositories = createAlembicRepositories(
    ct.get('database') as Parameters<typeof createAlembicRepositories>[0]
  );
  ct.singletons.coreRepositories = repositories;
  return repositories;
}
