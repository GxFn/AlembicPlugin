import { describe, expect, test } from 'vitest';
import { buildRescanCoverageModuleAxis } from '#recipe-generation/host-agent-workflows/knowledge-rescan.js';
import type { HostAgentProjectContextAnalysis } from '#recipe-generation/host-agent-workflows/project-context-analysis.js';
import type { PlanGenerationGateReady } from '#recipe-generation/plan-generation-gate.js';

describe('buildRescanCoverageModuleAxis', () => {
  test('prefers ProjectMap target modules over aggregate rescan seeds', () => {
    const result = buildRescanCoverageModuleAxis(
      analysisWithProjectMapTargets(),
      planGateWithAggregateBindings()
    );

    expect(result.source).toBe('project-map');
    expect(result.modules).toEqual([
      {
        moduleId: 'target:Account:Sources/Infrastructure/Account',
        moduleName: 'Account',
        ownedPaths: ['Sources/Infrastructure/Account'],
      },
      {
        moduleId: 'target:ServiceKit:Sources/Core/ServiceKit',
        moduleName: 'ServiceKit',
        ownedPaths: ['Sources/Core/ServiceKit'],
      },
    ]);
    expect(result.modules.map((module) => module.moduleId)).not.toContain('Sources');
    expect(result.modules.map((module) => module.moduleId)).not.toContain('target:Sources:Sources');
    expect(result.modules.map((module) => module.moduleId)).not.toContain('BiliDili');
  });

  test('falls back to rescan snapshot seeds when ProjectMap modules have no owned path', () => {
    const result = buildRescanCoverageModuleAxis(
      {
        ...analysisWithProjectMapTargets(),
        presenterInput: {
          map: {
            modules: [{ id: 'target:Account:Sources/Infrastructure/Account', name: 'Account' }],
          },
        },
      } as unknown as HostAgentProjectContextAnalysis,
      planGateWithAggregateBindings()
    );

    expect(result.source).toBe('rescan-snapshot');
    expect(result.modules.map((module) => module.moduleId)).toEqual(['Sources', 'BiliDili']);
  });

  test('uses ProjectContext target source facts instead of aggregate root modules', () => {
    const result = buildRescanCoverageModuleAxis(
      analysisWithAggregateMapAndSourceTargets(),
      planGateWithAggregateBindings()
    );

    expect(result.source).toBe('project-context-targets');
    expect(result.modules.map((module) => module.moduleId)).toEqual([
      'target:Networking:Sources/Infrastructure/Networking',
      'target:ServiceKit:Sources/Core/ServiceKit',
    ]);
    expect(result.modules.flatMap((module) => module.ownedPaths)).toEqual([
      'Sources/Infrastructure/Networking/Client/NetworkClient.swift',
      'Sources/Core/ServiceKit/ServiceRegistry.swift',
    ]);
    expect(result.modules.map((module) => module.moduleId)).not.toContain('BiliDili');
    expect(result.modules.map((module) => module.moduleId).join('\n')).not.toContain('module:root');
  });
});

function analysisWithProjectMapTargets(): HostAgentProjectContextAnalysis {
  return {
    moduleSeeds: [
      {
        moduleId: 'Sources',
        moduleName: 'Sources',
        modulePath: 'Sources',
        ownedFiles: ['Sources/App.swift'],
      },
    ],
    presenterInput: {
      map: {
        modules: [
          {
            id: 'Sources',
            name: 'Sources',
            ref: {
              id: 'module-sources',
              kind: 'module',
              scope: {
                projectRoot: '/project',
                filePath: 'Sources',
              },
            },
          },
          {
            id: 'target:Account:Sources/Infrastructure/Account',
            name: 'Account',
            ref: {
              id: 'module-account',
              kind: 'module',
              scope: {
                projectRoot: '/project',
                filePath: 'Sources/Infrastructure/Account',
              },
            },
          },
          {
            id: 'target:ServiceKit:Sources/Core/ServiceKit',
            name: 'ServiceKit',
            ref: {
              id: 'module-service-kit',
              kind: 'module',
              scope: {
                projectRoot: '/project',
                filePath: 'Sources/Core/ServiceKit',
              },
            },
          },
          {
            id: 'module:root:BiliDili:BiliDili',
            name: 'BiliDili',
            ref: {
              id: 'module-root',
              kind: 'module',
              scope: {
                projectRoot: '/project',
                filePath: 'BiliDili',
              },
            },
          },
          {
            id: 'root',
            name: 'root',
            ref: {
              id: 'root',
              kind: 'module',
              scope: {
                projectRoot: '/project',
                filePath: '.',
              },
            },
          },
        ],
      },
    },
  } as unknown as HostAgentProjectContextAnalysis;
}

function analysisWithAggregateMapAndSourceTargets(): HostAgentProjectContextAnalysis {
  return {
    moduleSeeds: [
      {
        moduleId: 'module:root:BiliDili:BiliDili',
        moduleName: 'BiliDili',
        modulePath: 'BiliDili',
        ownedFiles: ['BiliDili/AppDelegate.swift'],
      },
    ],
    presenterInput: {
      project: {
        displayName: 'BiliDili',
        projectId: 'root:/project/BiliDili',
        projectRoot: '/project/BiliDili',
      },
      repo: {
        targets: [
          { name: 'BiliDili', kind: 'target', refs: [] },
          { name: 'Networking', kind: 'target', refs: [] },
          { name: 'ServiceKit', kind: 'target', refs: [] },
        ],
      },
      map: {
        modules: [
          {
            id: 'module:root:BiliDili:BiliDili',
            name: 'BiliDili',
            ref: {
              id: 'module-root',
              kind: 'module',
              scope: {
                projectRoot: '/project/BiliDili',
                filePath: 'BiliDili',
              },
            },
          },
        ],
      },
    },
    sourceFileFacts: [
      {
        filePath: 'BiliDili/AppDelegate.swift',
        language: 'swift',
        sizeBytes: 100,
      },
      {
        filePath: 'Sources/Infrastructure/Networking/Client/NetworkClient.swift',
        language: 'swift',
        sizeBytes: 100,
      },
      {
        filePath: 'Sources/Core/ServiceKit/ServiceRegistry.swift',
        language: 'swift',
        sizeBytes: 100,
      },
    ],
  } as unknown as HostAgentProjectContextAnalysis;
}

function planGateWithAggregateBindings(): PlanGenerationGateReady {
  return {
    generationStage: 'deepMining',
    moduleScope: ['BiliDili'],
    projectRoot: '/project/BiliDili',
    moduleBindings: [
      {
        moduleId: 'BiliDili',
        modulePath: 'BiliDili',
        dimensions: ['architecture'],
        targetRecipes: 1,
      },
    ],
  } as unknown as PlanGenerationGateReady;
}
