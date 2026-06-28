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

function planGateWithAggregateBindings(): PlanGenerationGateReady {
  return {
    generationStage: 'deepMining',
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
