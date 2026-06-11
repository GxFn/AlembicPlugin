/**
 * Presentation Layer HTTP Routes — 单元测试
 *
 * 测试 panorama 路由对 DI 服务的调用。
 * RC4 route pruning removed the unconsumed guardReport / audit routes;
 * panorama stays keep-with-reason pending the RC6 surface decision.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRouter } from '../helpers/express.js';

/* ═══ Mock data ═══════════════════════════════════════════ */

const mockOverview = {
  projectRoot: '/test',
  moduleCount: 5,
  layerCount: 3,
  totalFiles: 100,
  totalRecipes: 20,
  overallCoverage: 0.2,
  layers: [
    {
      level: 0,
      name: 'Foundation',
      modules: [{ name: 'Utils', role: 'utility', fileCount: 10, recipeCount: 2 }],
    },
  ],
  cycleCount: 1,
  gapCount: 2,
  healthRadar: {
    dimensions: [],
    overallScore: 20,
    totalRecipes: 20,
    coveredDimensions: 2,
    totalDimensions: 11,
    dimensionCoverage: 0.18,
  },
  computedAt: Date.now(),
  stale: false,
};

const mockHealth = {
  healthRadar: {
    dimensions: [],
    overallScore: 20,
    totalRecipes: 20,
    coveredDimensions: 2,
    totalDimensions: 11,
    dimensionCoverage: 0.18,
  },
  avgCoupling: 3.5,
  cycleCount: 1,
  gapCount: 2,
  highPriorityGaps: 1,
  moduleCount: 5,
  healthScore: 65,
};

const mockGaps = [
  {
    dimension: 'error-handling',
    dimensionName: '错误处理',
    recipeCount: 0,
    status: 'missing',
    priority: 'high',
    suggestedTopics: ['exception-pattern'],
    affectedRoles: ['service'],
  },
  {
    dimension: 'concurrency',
    dimensionName: '并发与线程',
    recipeCount: 1,
    status: 'weak',
    priority: 'medium',
    suggestedTopics: ['thread-safety'],
    affectedRoles: [],
  },
];

const mockModuleDetail = {
  module: { name: 'Utils', fileCount: 10 },
  layerName: 'Foundation',
  neighbors: [],
  fileGroups: [{ group: '(root)', files: [], count: 10 }],
  recipes: [],
  uncoveredFileCount: 10,
  summary: 'Utils is a Foundation layer module.',
};

/* ═══ Mock services ════════════════════════════════════════ */

const mockPanoramaService = {
  getOverview: vi.fn().mockReturnValue(mockOverview),
  getHealth: vi.fn().mockReturnValue(mockHealth),
  getGaps: vi.fn().mockReturnValue(mockGaps),
  getModule: vi
    .fn()
    .mockImplementation((name: string) => (name === 'Utils' ? mockModuleDetail : null)),
};

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => ({
    get: (name: string) => {
      const map: Record<string, unknown> = {
        panoramaService: mockPanoramaService,
      };
      return map[name] ?? null;
    },
    singletons: { _projectRoot: '/test' },
    logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  })),
}));

vi.mock('@alembic/core/workspace', () => ({
  resolveProjectRoot: vi.fn(() => '/test'),
}));

/* ═══ Import routes (after mocks) ═════════════════════════ */

import panoramaRouter from '../../lib/http/routes/panorama.js';

/* ═══ Test helper ═════════════════════════════════════════ */

async function testGet(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (path.startsWith('/api/v1/panorama')) {
    return getRouter(panoramaRouter, path, { mountPath: '/api/v1/panorama' });
  }
  throw new Error(`Unknown route under test: ${path}`);
}

/* ═══ Tests ════════════════════════════════════════════════ */

describe('Panorama Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /panorama returns overview', async () => {
    const { status, body } = await testGet('/api/v1/panorama');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as Record<string, unknown>).moduleCount).toBe(5);
    expect(mockPanoramaService.getOverview).toHaveBeenCalled();
  });

  it('GET /panorama/health returns health', async () => {
    const { status, body } = await testGet('/api/v1/panorama/health');
    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).healthScore).toBe(65);
    expect(mockPanoramaService.getHealth).toHaveBeenCalled();
  });

  it('GET /panorama/gaps returns gaps', async () => {
    const { status, body } = await testGet('/api/v1/panorama/gaps');
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(2);
  });

  it('GET /panorama/module/:name returns detail', async () => {
    const { status, body } = await testGet('/api/v1/panorama/module/Utils');
    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).layerName).toBe('Foundation');
    expect(mockPanoramaService.getModule).toHaveBeenCalledWith('Utils');
  });

  it('GET /panorama/module/:name 404 for unknown', async () => {
    const { status, body } = await testGet('/api/v1/panorama/module/Unknown');
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });
});
