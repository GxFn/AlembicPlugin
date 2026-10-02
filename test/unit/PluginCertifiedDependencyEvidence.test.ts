import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectDescriptor,
  createProjectScopeRegistryDocument,
  PROJECT_SCOPE_REGISTRY_FILENAME,
} from '@alembic/core/shared';
import { afterEach, describe, expect, test } from 'vitest';
import { capturePluginCertifiedProjectFacts } from '../../lib/project-facts/PluginCertifiedProjectFactsProducer.js';
import { openPluginCertifiedFacts } from '../../lib/project-facts/PluginCertifiedProjectFactsRuntime.js';

const tempRoots: string[] = [];
const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

/** 一个带原生 ProjectScope 的最小项目：一个源码目录，入口文件用到两个外部依赖。 */
function createProjectWithExternalDependencies(): { projectRoot: string; dataRoot: string } {
  const projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-certified-dependency-'))
  );
  tempRoots.push(projectRoot);
  process.env.ALEMBIC_HOME = projectRoot;
  const runtimeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-certified-dependency-data-'));
  tempRoots.push(runtimeParent);
  const sourceRoot = path.join(projectRoot, 'app');
  fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, 'package.json'),
    JSON.stringify({ name: '@fixture/dependency-evidence', type: 'module' }, null, 2)
  );
  fs.writeFileSync(
    path.join(sourceRoot, 'src/index.ts'),
    [
      "import { readFileSync } from 'node:fs';",
      "import { z } from 'zod';",
      "import { helper } from './helper';",
      '',
      'export function load(file: string) {',
      '  return z.string().parse(helper(readFileSync(file, "utf8")));',
      '}',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(sourceRoot, 'src/helper.ts'),
    'export function helper(value: string) {\n  return value.trim();\n}\n'
  );
  const descriptor = createProjectDescriptor({
    controlRoot: projectRoot,
    dataRoot: path.join(runtimeParent, 'project-data'),
    displayName: 'Dependency Evidence',
    folders: [
      {
        displayName: 'app',
        id: 'folder-app',
        path: sourceRoot,
        repositoryId: 'app',
        role: 'primary-source',
      },
    ],
    projectId: 'dependency-evidence',
    projectScopeId: 'scope-dependency-evidence',
  });
  fs.mkdirSync(path.join(projectRoot, '.asd'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.asd', PROJECT_SCOPE_REGISTRY_FILENAME),
    JSON.stringify(createProjectScopeRegistryDocument([descriptor]), null, 2)
  );
  return { projectRoot, dataRoot: sourceRoot };
}

describe('Plugin 认证捕获里的依赖证据', () => {
  test('带外部依赖的项目通过就绪，决议由 Core 的端口给出', async () => {
    const { projectRoot, dataRoot } = createProjectWithExternalDependencies();

    // 捕获内部在就绪未通过时会直接抛错；能拿到载体就说明"观测数 = 决议数"已经成立。
    const { carrier } = await capturePluginCertifiedProjectFacts({ projectRoot, dataRoot });
    const { artifact } = await openPluginCertifiedFacts({ carrier, dataRoot });

    expect(artifact.readiness).toMatchObject({ verdict: 'passed', errors: [] });
    const map = artifact.facts.requestOutcomes.find((row) => row.kind === 'map');
    expect(map?.dependencyObservationCount).toBe(2);
    // 宿主没有归属目录：两条外部依赖按名字归为预期外部，相对导入解析到项目内，不算依赖观测。
    expect(map?.dependencyResolutions).toEqual([
      {
        classification: 'expected-external',
        dependencyName: 'node:fs',
        importerRepoId: 'app',
        requestKind: 'map',
        typedReason: 'core-host-port-diagnostic-has-no-canonical-ownership-binding',
      },
      {
        classification: 'expected-external',
        dependencyName: 'zod',
        importerRepoId: 'app',
        requestKind: 'map',
        typedReason: 'core-host-port-diagnostic-has-no-canonical-ownership-binding',
      },
    ]);
    // 对账来自依赖图里真实的外部热点，与决议的名字一一对应。
    expect(map?.dependencyGraphReconciliation).toMatchObject({
      originalExternalDependencyNames: ['node:fs', 'zod'],
      remainingExternalDependencyNames: ['node:fs', 'zod'],
      internalResolvedDependencyNames: [],
      approvedSiblingDependencyNames: [],
    });
    for (const row of artifact.facts.requestOutcomes) {
      expect(row.dependencyResolutions ?? []).toHaveLength(row.dependencyObservationCount ?? 0);
    }
  }, 120_000);
});
