/**
 * F1 — 发布工作流与自身包边界门禁不再互相矛盾（结构化规则版）。
 *
 * - 私有根包（alembic-codex-plugin-runtime）永远不能发布；`--publish` 模式继续 exit 1。
 * - prepared 自足 runtime 包（.tmp/alembic-runtime-package，alembic-runtime）允许在 tag 发布，
 *   但只能通过“独立发布 step + working-directory 指向该目录”的结构：
 *   step 的 working-directory（相对 job / workflow defaults 的根包目录）必须恰好是
 *   .tmp/alembic-runtime-package，run 块内不得出现 cd / pushd / popd，
 *   发布命令不得带位置参数或改写目标包的选项。其它一切写法都 fail closed。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'verify-release-package-boundary.mjs');
const ROOT_PUBLISH_ERROR = /^Release workflow must not publish the private root package/;
const RUNTIME_DIR = 'AlembicPlugin/.tmp/alembic-runtime-package';

interface PublishInspection {
  errors: string[];
  publishCommands: Array<{ job: string; step: string; directory: string | null; command: string }>;
}

interface BoundaryModule {
  RUNTIME_PACKAGE_PUBLISH_DIR: string;
  inspectReleaseWorkflowPublishBoundary: (source: string) => PublishInspection;
  verifyReleasePackageBoundary: (options: { root: string; publishMode?: boolean }) => {
    errors: string[];
  };
}

async function loadModule(): Promise<BoundaryModule> {
  return (await import('../../scripts/verify-release-package-boundary.mjs')) as BoundaryModule;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

function defaultsBlock(indent: string, dir: string | undefined): string[] {
  return dir === undefined
    ? []
    : [`${indent}defaults:`, `${indent}  run:`, `${indent}    working-directory: ${dir}`];
}

function workflow(
  stepYaml: string,
  options: { jobDefaults?: string; workflowDefaults?: string } = { jobDefaults: 'AlembicPlugin' }
): string {
  return [
    'name: Release',
    'on:',
    '  push:',
    '    tags:',
    "      - 'v*'",
    ...defaultsBlock('', options.workflowDefaults),
    'jobs:',
    '  release:',
    '    runs-on: ubuntu-latest',
    ...defaultsBlock('    ', options.jobDefaults),
    '    steps:',
    '      - uses: actions/checkout@v5',
    '        with:',
    '          path: AlembicPlugin',
    stepYaml,
    '      - uses: actions/upload-artifact@v5',
    '',
  ].join('\n');
}

/** 生成一个发布 step；workingDirectory 为 null 时不写该键（继承 defaults）。 */
function publishStep(lines: string[], workingDirectory: string | null = RUNTIME_DIR): string {
  return [
    '      - name: Publish',
    ...(workingDirectory === null ? [] : [`        working-directory: ${workingDirectory}`]),
    '        run: |',
    ...lines.map((line) => `          ${line}`),
  ].join('\n');
}

async function inspect(source: string): Promise<PublishInspection> {
  const { inspectReleaseWorkflowPublishBoundary } = await loadModule();
  return inspectReleaseWorkflowPublishBoundary(source);
}

function expectRootPublishRejected(inspection: PublishInspection, label?: string): void {
  expect(inspection.errors.length, label).toBeGreaterThan(0);
  for (const error of inspection.errors) {
    expect(error, label).toMatch(ROOT_PUBLISH_ERROR);
  }
}

describe('release package boundary CLI on the real repository', () => {
  test('passes: the release workflow only publishes the prepared runtime package', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.stderr).not.toContain('must not publish');
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(summary.ok).toBe(true);
    expect(summary.private).toBe(true);
    expect(summary.rootRegistryPublish).toBe('disabled');
  });

  test('--publish (root prepublishOnly guard) keeps failing closed with exit 1', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--publish'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Blocked root registry publication');
  });
});

describe('inspectReleaseWorkflowPublishBoundary', () => {
  test('accepts the real release.yml: a separate publish step pinned to the runtime dir', async () => {
    const source = readFileSync(path.join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');
    const inspection = await inspect(source);
    expect(inspection.errors).toEqual([]);
    expect(inspection.publishCommands).toHaveLength(1);
    expect(inspection.publishCommands[0]?.directory).toBe(RUNTIME_DIR);
    expect(inspection.publishCommands[0]?.command).toBe('npm publish --access public');
    // 准备步骤在仓库根目录执行，发布步骤不再在 run 块里 cd。
    expect(source).toContain('npm run prepare:codex-runtime-package');
    expect(source).not.toMatch(/^\s*(?:cd|pushd|popd)\b/m);
  });

  test('accepts publish from a step working-directory equal to the runtime dir', async () => {
    for (const dir of [
      RUNTIME_DIR,
      `./${RUNTIME_DIR}/`,
      `AlembicPlugin/x/../.tmp/alembic-runtime-package`,
    ]) {
      const inspection = await inspect(workflow(publishStep(['npm publish --access public'], dir)));
      expect(inspection.errors, dir).toEqual([]);
      expect(inspection.publishCommands, dir).toHaveLength(1);
    }
  });

  test.each([
    ['npm publish'],
    ['npm publish --access public --tag next'],
    ['npm publish --access=public --provenance'],
    ['npx npm publish --access public'],
    ['pnpm publish --access public --no-git-checks'],
    ['yarn npm publish --access public'],
    [
      'if npm view "x@1" version >/dev/null 2>&1; then echo skip; else npm publish --access public; fi',
    ],
  ])('accepts a plain publish command inside the runtime dir: %s', async (command) => {
    const inspection = await inspect(workflow(publishStep([command])));
    expect(inspection.errors).toEqual([]);
    expect(inspection.publishCommands).toHaveLength(1);
  });

  test.each([
    ['single-line root publish', ['npm publish --access public']],
    [
      'multi-line root publish',
      ['npm run prepare:codex-runtime-package', 'npm publish --access public'],
    ],
    ['double-spaced npm  publish', ['npm  publish']],
    ['tab-separated publish', ['npm\tpublish']],
    ['line-continuation publish', ['npm \\', '  publish']],
    ['npx wrapper', ['npx npm publish']],
    ['sudo wrapper', ['sudo npm publish']],
    ['pnpm publish', ['pnpm publish']],
    ['yarn npm publish', ['yarn npm publish']],
    ['publish inside a subshell', ['(npm publish)']],
  ])('rejects a publish without the runtime working-directory: %s', async (label, lines) => {
    expectRootPublishRejected(await inspect(workflow(publishStep(lines, null))), label);
  });

  test.each([
    [
      'cd && publish on one line',
      ['cd .tmp/alembic-runtime-package && npm publish --access public'],
    ],
    ['cd on its own line', ['cd .tmp/alembic-runtime-package', 'npm publish --access public']],
    ['pushd / popd', ['pushd .tmp/alembic-runtime-package', 'npm publish', 'popd']],
    ['builtin cd', ['builtin cd .tmp/alembic-runtime-package', 'npm publish']],
    ['cd inside a subshell', ['(cd .tmp/alembic-runtime-package && npm publish)']],
    ['cd inside bash -c', ['bash -c "cd .tmp/alembic-runtime-package && npm publish"']],
  ])('rejects any cd / pushd / popd in a publish step without working-directory: %s', async (label, lines) => {
    expectRootPublishRejected(await inspect(workflow(publishStep(lines, null))), label);
  });

  test.each([
    ['cd . in the runtime dir', ['cd .', 'npm publish']],
    ['cd back to the root', ['cd ../..', 'npm publish']],
    ['pushd elsewhere', ['pushd ../..', 'npm publish', 'popd']],
  ])('rejects cd / pushd / popd even when working-directory is correct: %s', async (label, lines) => {
    expectRootPublishRejected(await inspect(workflow(publishStep(lines))), label);
  });

  test.each([
    ['the root package dir', 'AlembicPlugin'],
    [
      'the runtime dir relative to the workspace instead of the root package',
      '.tmp/alembic-runtime-package',
    ],
    ['a sibling repository', 'AlembicCore'],
    ['the runtime dir then back out', `${RUNTIME_DIR}/..`],
    ['a nested dir inside the runtime package', `${RUNTIME_DIR}/sub`],
    ['an absolute path', `/home/runner/work/${RUNTIME_DIR}`],
    // 拼接以避免 lint 把 GitHub 表达式当成模板占位符。
    ['an expression', ['$', '{{ env.RUNTIME_DIR }}'].join('')],
  ])('rejects a working-directory pointing elsewhere: %s', async (label, dir) => {
    expectRootPublishRejected(await inspect(workflow(publishStep(['npm publish'], dir))), label);
  });

  test.each([
    ['positional parent folder', 'npm publish ../..'],
    ['positional current folder', 'npm publish .'],
    ['positional tarball', 'npm publish ./alembic-runtime.tgz'],
    ['--prefix before publish', 'npm --prefix ../.. publish'],
    ['--prefix=', 'npm publish --prefix=../..'],
    ['--prefix value', 'npm publish --prefix ../..'],
    ['-C', 'npm publish -C ../..'],
    ['--workspaces', 'npm publish --workspaces'],
    ['--workspace=', 'npm publish --workspace=alembic'],
    ['-w', 'npm publish -w alembic'],
    ['pnpm recursive', 'pnpm -r publish'],
    ['pnpm --filter', 'pnpm publish --filter alembic'],
    ['yarn workspace', 'yarn workspace alembic npm publish'],
    ['env --chdir', 'env -C ../.. npm publish'],
    ['unknown option', 'npm publish --registry-dir ../..'],
  ])('rejects publish commands that retarget the package: %s', async (label, command) => {
    expectRootPublishRejected(await inspect(workflow(publishStep([command]))), label);
  });

  test('honors workflow-level defaults when the job has none', async () => {
    const accepted = await inspect(
      workflow(publishStep(['npm publish']), { workflowDefaults: 'AlembicPlugin' })
    );
    expect(accepted.errors).toEqual([]);
    expect(accepted.publishCommands[0]?.directory).toBe(RUNTIME_DIR);

    const rejected = await inspect(
      workflow(publishStep(['npm publish'], '.tmp/alembic-runtime-package'), {
        workflowDefaults: 'AlembicPlugin',
      })
    );
    expectRootPublishRejected(rejected);
  });

  test('job-level defaults override workflow-level defaults', async () => {
    const inspection = await inspect(
      workflow(publishStep(['npm publish']), {
        workflowDefaults: 'Elsewhere',
        jobDefaults: 'AlembicPlugin',
      })
    );
    expect(inspection.errors).toEqual([]);
  });

  test('without any defaults the runtime dir is relative to the workspace root', async () => {
    const accepted = await inspect(
      workflow(publishStep(['npm publish'], '.tmp/alembic-runtime-package'), {})
    );
    expect(accepted.errors).toEqual([]);
    expectRootPublishRejected(await inspect(workflow(publishStep(['npm publish'], null), {})));
  });

  test('rejects a working-directory inherited only from defaults (no explicit step dir)', async () => {
    expectRootPublishRejected(
      await inspect(workflow(publishStep(['npm publish'], null), { jobDefaults: RUNTIME_DIR }))
    );
  });

  test('rejects publish actions and unparsable workflows', async () => {
    const viaAction = await inspect(
      workflow(
        [
          '      - name: Publish',
          '        uses: JS-DevTools/npm-publish@v3',
          '        with:',
          '          token: x',
        ].join('\n')
      )
    );
    expectRootPublishRejected(viaAction);
    const broken = await inspect('jobs: [unterminated\n  npm publish');
    expect(broken.errors.length).toBeGreaterThan(0);
  });

  test('accepts a workflow with no publish at all, including cd in non-publish steps', async () => {
    const inspection = await inspect(
      workflow(
        [
          '      - name: Test',
          '        run: |',
          '          cd scripts',
          '          npm run test:unit',
          '          npm view alembic-runtime version',
        ].join('\n')
      )
    );
    expect(inspection.errors).toEqual([]);
    expect(inspection.publishCommands).toEqual([]);
  });
});

describe('verifyReleasePackageBoundary root package guards', () => {
  function makeFixtureRoot(mutate: (pkg: Record<string, unknown>) => void): string {
    const fixture = mkdtempSync(path.join(tmpdir(), 'alembic-release-boundary-'));
    tempRoots.push(fixture);
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    mutate(pkg);
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg, null, 2));
    mkdirSync(path.join(fixture, 'packages', 'alembic-runtime'), { recursive: true });
    cpSync(
      path.join(REPO_ROOT, 'packages', 'alembic-runtime', 'package.json'),
      path.join(fixture, 'packages', 'alembic-runtime', 'package.json')
    );
    mkdirSync(path.join(fixture, 'config'), { recursive: true });
    cpSync(
      path.join(REPO_ROOT, 'config', 'default.json'),
      path.join(fixture, 'config', 'default.json')
    );
    mkdirSync(path.join(fixture, '.github', 'workflows'), { recursive: true });
    cpSync(
      path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'),
      path.join(fixture, '.github', 'workflows', 'release.yml')
    );
    mkdirSync(path.join(fixture, 'plugins', 'alembic-codex', 'bin'), { recursive: true });
    writeFileSync(path.join(fixture, 'plugins', 'alembic-codex', 'bin', 'alembic-start.mjs'), '');
    return fixture;
  }

  test('a faithful fixture passes', async () => {
    const { verifyReleasePackageBoundary } = await loadModule();
    const fixture = makeFixtureRoot(() => {});
    expect(verifyReleasePackageBoundary({ root: fixture }).errors).toEqual([]);
  });

  test('a non-private root package is rejected', async () => {
    const { verifyReleasePackageBoundary } = await loadModule();
    const fixture = makeFixtureRoot((pkg) => {
      pkg.private = false;
    });
    expect(verifyReleasePackageBoundary({ root: fixture }).errors.join('\n')).toMatch(
      /root package must be private/
    );
  });

  test('removing the disabled prepublishOnly guard is rejected', async () => {
    const { verifyReleasePackageBoundary } = await loadModule();
    const fixture = makeFixtureRoot((pkg) => {
      const scripts = pkg.scripts as Record<string, string>;
      delete scripts.prepublishOnly;
    });
    expect(verifyReleasePackageBoundary({ root: fixture }).errors.join('\n')).toMatch(
      /prepublishOnly/
    );
  });

  test('dropping the publish step working-directory in the fixture workflow is rejected', async () => {
    const { verifyReleasePackageBoundary } = await loadModule();
    const fixture = makeFixtureRoot(() => {});
    const workflowPath = path.join(fixture, '.github', 'workflows', 'release.yml');
    const original = readFileSync(workflowPath, 'utf8');
    const source = original.replace(`        working-directory: ${RUNTIME_DIR}\n`, '');
    expect(source).not.toBe(original);
    writeFileSync(workflowPath, source);
    expect(verifyReleasePackageBoundary({ root: fixture }).errors.join('\n')).toMatch(
      /private root package/
    );
  });

  test('publish mode always fails closed', async () => {
    const { verifyReleasePackageBoundary } = await loadModule();
    const fixture = makeFixtureRoot(() => {});
    expect(
      verifyReleasePackageBoundary({ root: fixture, publishMode: true }).errors.join('\n')
    ).toMatch(/Blocked root registry publication/);
  });
});
