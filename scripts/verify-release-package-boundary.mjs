#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

// 发布边界：私有根包（alembic-codex-plugin-runtime）永远不进 registry；
// 只有 prepare:codex-runtime-package 产出的自足 runtime 包（alembic-runtime）可以在 tag 发布。
// 结构规则（刻意不做 shell 解析）：发布必须放在独立 step，用 working-directory 固定到
// 根包目录下的 RUNTIME_PACKAGE_PUBLISH_DIR，run 块里不得 cd/pushd/popd，
// 发布命令不得带改写目标包的参数。任何不符合的写法都 fail closed。
export const RUNTIME_PACKAGE_PUBLISH_DIR = '.tmp/alembic-runtime-package';

const ROOT_PUBLISH_ERROR = 'Release workflow must not publish the private root package';
const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn']);
const DIRECTORY_COMMANDS = new Set(['cd', 'pushd', 'popd']);
// publish 之后只允许这些选项；其余选项与任何位置参数（<folder|tarball>）都可能改写发布目标。
const PUBLISH_VALUE_OPTIONS = new Set(['--access', '--tag', '--otp']);
const PUBLISH_FLAG_OPTIONS = new Set(['--provenance', '--dry-run', '--no-git-checks', '--json']);
// 出现在包管理器之前（包装命令，如 env -C）即会改写执行目录或目标包的 token。
const RETARGETING_TOKENS = new Set([
  '-C',
  '--chdir',
  '--prefix',
  '--dir',
  '--cwd',
  '-w',
  '--workspace',
  '--workspaces',
  'workspace',
  'workspaces',
  '-r',
  '--recursive',
  '--filter',
  '-F',
]);

/**
 * 检查 release workflow 中每个发布命令都只发布 prepared runtime 包。
 * 纯函数：只解析传入的 workflow 文本，不读写文件系统。
 *
 * - 根包目录 = job defaults.run.working-directory ?? workflow defaults ?? '.'；
 *   允许的发布目录 = 根包目录/RUNTIME_PACKAGE_PUBLISH_DIR。
 * - GitHub 中 step working-directory 覆盖 defaults（两者都相对 $GITHUB_WORKSPACE），
 *   所以 step 必须显式写出规范化后恰好等于允许目录的 working-directory。
 *
 * @param {string} workflowSource release.yml 原文
 * @returns {{ errors: string[], publishCommands: Array<{ job: string, step: string, directory: string | null, command: string }> }}
 */
export function inspectReleaseWorkflowPublishBoundary(workflowSource) {
  const errors = [];
  const publishCommands = [];
  let workflow;
  try {
    workflow = loadYaml(workflowSource);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    errors.push(`Release workflow must be valid YAML to verify npm publish boundaries: ${reason}`);
    return { errors, publishCommands };
  }
  const reject = (where, problem) => {
    errors.push(
      `${ROOT_PUBLISH_ERROR}: ${where} ${problem}; publish only from a separate step whose working-directory is "${RUNTIME_PACKAGE_PUBLISH_DIR}" under the root package directory, without cd/pushd/popd or retargeting arguments`
    );
  };
  const jobs = isRecord(workflow) && isRecord(workflow.jobs) ? workflow.jobs : {};
  const workflowDefaultDir = readDefaultWorkingDirectory(workflow);

  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isRecord(job)) {
      continue;
    }
    if (typeof job.uses === 'string' && /publish/i.test(job.uses)) {
      reject(`job "${jobId}"`, `calls publish workflow "${job.uses}"`);
    }
    const rootDir = readDefaultWorkingDirectory(job) ?? workflowDefaultDir ?? '.';
    // 根包目录不可静态解析（表达式 / 绝对路径）时 allowedDir 为 null，任何发布都不匹配。
    const allowedDir =
      normalizeDir(rootDir) === null
        ? null
        : normalizeDir(posix.join(rootDir.trim(), RUNTIME_PACKAGE_PUBLISH_DIR));
    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((step, index) => {
      if (!isRecord(step)) {
        return;
      }
      const stepLabel = typeof step.name === 'string' ? step.name : `steps[${index}]`;
      const where = `step "${jobId} / ${stepLabel}"`;
      if (typeof step.uses === 'string' && /publish/i.test(step.uses)) {
        reject(where, `uses publish action "${step.uses}"`);
      }
      if (typeof step.run !== 'string') {
        return;
      }
      const commands = splitShellCommands(step.run);
      const publishes = commands.map(findPublishCommand).filter((found) => found !== null);
      if (publishes.length === 0) {
        return;
      }
      const rawDir = step['working-directory'];
      const directory = normalizeDir(typeof rawDir === 'string' ? rawDir : rootDir);
      if (directory === null || directory !== allowedDir) {
        const shown =
          typeof rawDir === 'string' ? `working-directory "${rawDir}"` : 'no working-directory';
        reject(where, `publishes with ${shown} instead of "${allowedDir ?? '<unresolvable>'}"`);
      }
      const directoryCommands = new Set(
        commands.flat().filter((token) => DIRECTORY_COMMANDS.has(token))
      );
      for (const command of directoryCommands) {
        reject(where, `publishes from a run block that changes directory with "${command}"`);
      }
      for (const publish of publishes) {
        const text = publish.tokens.join(' ');
        publishCommands.push({ job: jobId, step: stepLabel, directory, command: text });
        for (const problem of describePublishRetargeting(publish)) {
          reject(where, `runs "${text}" ${problem}`);
        }
      }
    });
  }
  return { errors, publishCommands };
}

/**
 * 完整的发布包边界检查（根包私有、禁用 root 发布守卫、插件 shell 产物、workflow 发布边界）。
 *
 * @param {{ root: string, publishMode?: boolean }} options
 * @returns {{ errors: string[], summary: Record<string, unknown> }}
 */
export function verifyReleasePackageBoundary({ root, publishMode = false }) {
  const packageJsonPath = join(root, 'package.json');
  const runtimePackageJsonPath = join(root, 'packages', 'alembic-runtime', 'package.json');
  const rootConfigPath = join(root, 'config', 'default.json');
  const releaseWorkflowPath = join(root, '.github', 'workflows', 'release.yml');
  const pluginRoot = join(root, 'plugins', 'alembic-codex');
  const packageJson = readJson(packageJsonPath);
  const runtimePackageJson = readJson(runtimePackageJsonPath);
  const rootConfig = readJson(rootConfigPath);
  const releaseWorkflowSource = existsSync(releaseWorkflowPath)
    ? readFileSync(releaseWorkflowPath, 'utf8')
    : '';
  const rootParentFileDependencies = collectFileParentDependencies(packageJson);
  const errors = [];
  const expect = (condition, message) => {
    if (!condition) {
      errors.push(message);
    }
  };
  const runtimeSpecifier = `${runtimePackageJson.name}@${runtimePackageJson.version}`;

  expect(
    packageJson.name === 'alembic-codex-plugin-runtime',
    'root package identity must remain the private development package'
  );
  expect(packageJson.private === true, 'root package must be private and unavailable to registry');
  expect(runtimePackageJson.name === 'alembic-runtime', 'runtime package must be alembic-runtime');
  expect(
    runtimePackageJson.version === packageJson.version,
    'runtime package version must match root package version'
  );
  expect(
    runtimePackageJson.publishConfig?.access === 'public',
    'runtime package publishConfig.access must be public'
  );
  expect(
    runtimePackageJson.dependencies?.['@alembic/core'] === packageJson.version,
    'runtime package must pin @alembic/core to the release version'
  );
  expect(
    !Object.hasOwn(rootConfig, 'ai'),
    'root config/default.json must not ship an AlembicPlugin-owned AI provider default'
  );
  expect(!existsSync(join(pluginRoot, 'runtime')), 'public plugin shell must not contain runtime/');
  expect(
    !existsSync(join(pluginRoot, 'runtime.tgz')),
    'public plugin shell must not contain runtime.tgz'
  );
  expect(
    !existsSync(join(pluginRoot, 'node_modules')),
    'public plugin shell must not contain node_modules/'
  );
  expect(
    existsSync(join(pluginRoot, 'bin', 'alembic-start.mjs')),
    'public plugin shell must contain bin/alembic-start.mjs'
  );

  expect(
    packageJson.scripts?.prepublishOnly === 'npm run release:root-npm-publish:disabled',
    'prepublishOnly must point at the disabled root registry publication guard'
  );
  expect(
    packageJson.scripts?.['release:root-npm-publish:disabled'] ===
      'node scripts/verify-release-package-boundary.mjs --publish',
    'package.json must expose release:root-npm-publish:disabled'
  );
  for (const legacyReleaseAlias of ['release:patch', 'release:minor', 'release:major']) {
    expect(
      packageJson.scripts?.[legacyReleaseAlias] === 'npm run release:root-npm-publish:disabled',
      `${legacyReleaseAlias} must fail closed through the root publication guard`
    );
  }

  expect(Boolean(releaseWorkflowSource), 'Release workflow must exist');
  // 旧门禁曾整体禁止 workflow 出现 npm publish，与 tag 发布 alembic-runtime 的步骤冲突；
  // 现在只允许独立 step 通过 working-directory 在 prepared runtime 包目录内发布，根包发布仍被拒绝。
  const workflowPublish = inspectReleaseWorkflowPublishBoundary(releaseWorkflowSource);
  errors.push(...workflowPublish.errors);
  expect(
    releaseWorkflowSource.includes('actions/upload-artifact'),
    'Release workflow must upload Codex plugin artifacts'
  );
  expect(
    !releaseWorkflowSource.includes('AlembicPlugin/plugins/alembic-codex/runtime.tgz'),
    'Release workflow must not upload the removed runtime.tgz artifact'
  );
  expect(
    releaseWorkflowSource.includes('plugins/alembic-codex/bin/alembic-start.mjs'),
    'Release workflow must upload the marketplace shell startup'
  );
  expect(
    releaseWorkflowSource.includes('packages/alembic-runtime/package.json'),
    'Release workflow must upload runtime package boundary metadata'
  );

  if (publishMode) {
    errors.push(
      [
        'Blocked root registry publication: AlembicPlugin root is private.',
        `Publish or consume the runtime through ${runtimeSpecifier}; installable Codex plugin snapshots contain only the marketplace shell and metadata.`,
        rootParentFileDependencies.length > 0
          ? [
              'Root workspace-local file dependencies remain for development only:',
              ...rootParentFileDependencies.map(
                (dependency) => `- ${dependency.field}.${dependency.name}: ${dependency.value}`
              ),
            ].join('\n')
          : '',
      ].join('\n')
    );
  }

  return {
    errors,
    summary: {
      ok: errors.length === 0,
      publishMode,
      rootPackage: `${packageJson.name}@${packageJson.version}`,
      private: packageJson.private === true,
      runtimeSpecifier,
      rootParentFileDependencies,
      rootRegistryPublish: 'disabled',
      runtimePackagePublish: {
        directory: RUNTIME_PACKAGE_PUBLISH_DIR,
        steps: workflowPublish.publishCommands.map((command) => ({
          job: command.job,
          step: command.step,
          directory: command.directory,
        })),
      },
      codexPluginArtifactRelease: 'marketplace-shell',
      forbiddenShellArtifactsAbsent: true,
    },
  };
}

/**
 * 合并反斜杠续行后按换行与 shell 控制符（; & | ( ) 反引号）切分命令，去掉引号后按空白分词。
 * 这不是 shell 解析器：只用于找出发布命令和 cd/pushd/popd，误判一律偏向拒绝。
 */
function splitShellCommands(runSource) {
  return runSource
    .replace(/\\\r?\n/g, ' ')
    .split(/[\n;&|()`]/)
    .map((command) => command.replace(/["']/g, '').trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

/** 找到 `<npm|pnpm|yarn> ... publish`；publisherIndex 取 publish 之前最近的包管理器。 */
function findPublishCommand(tokens) {
  const publishIndex = tokens.findIndex(
    (token, index) => token === 'publish' && tokens.slice(0, index).some(isPublisher)
  );
  if (publishIndex < 0) {
    return null;
  }
  let publisherIndex = publishIndex - 1;
  while (!isPublisher(tokens[publisherIndex])) {
    publisherIndex -= 1;
  }
  return { tokens, publisherIndex, publishIndex };
}

function isPublisher(token) {
  return PUBLISHERS.has(posix.basename(token));
}

function describePublishRetargeting({ tokens, publisherIndex, publishIndex }) {
  const problems = [];
  for (const token of tokens.slice(0, publisherIndex)) {
    if (RETARGETING_TOKENS.has(token.split('=')[0])) {
      problems.push(`with retargeting token "${token}" before the package manager`);
    }
  }
  // 包管理器与 publish 之间的任何 token（--prefix x / -r / workspace foo）都会改写目标。
  for (const token of tokens.slice(publisherIndex + 1, publishIndex)) {
    problems.push(`with "${token}" between the package manager and publish`);
  }
  const args = tokens.slice(publishIndex + 1);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const name = token.split('=')[0];
    if (PUBLISH_VALUE_OPTIONS.has(name)) {
      index += name === token ? 1 : 0;
      continue;
    }
    if (PUBLISH_FLAG_OPTIONS.has(token)) {
      continue;
    }
    problems.push(
      token.startsWith('-')
        ? `with option "${token}" that may retarget the package`
        : `with positional publish target "${token}"`
    );
  }
  return problems;
}

/** 规范化相对目录；表达式、变量、家目录、绝对路径或越出工作区的路径返回 null。 */
function normalizeDir(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || /[$`~*?]/.test(trimmed) || trimmed.startsWith('/')) {
    return null;
  }
  const normalized = posix.normalize(trimmed).replace(/\/+$/, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized === '' ? '.' : normalized;
}

function readDefaultWorkingDirectory(owner) {
  const run = isRecord(owner) && isRecord(owner.defaults) ? owner.defaults.run : undefined;
  const value = isRecord(run) ? run['working-directory'] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectFileParentDependencies(manifest) {
  const fields = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
  const dependencies = [];
  for (const field of fields) {
    const entries = manifest[field] && typeof manifest[field] === 'object' ? manifest[field] : {};
    for (const [name, value] of Object.entries(entries)) {
      if (typeof value === 'string' && /^file:\.\.(?:\/|$)/.test(value)) {
        dependencies.push({ field, name, value });
      }
    }
  }
  return dependencies;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isDirectRun() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch (err) {
    // argv[1] 不可解析（例如被其它工具以模块方式加载）时不执行 CLI。
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[verify-release-package-boundary] CLI entry not detected: ${reason}`);
    return false;
  }
}

if (isDirectRun()) {
  const root = resolve(import.meta.dirname, '..');
  const publishMode = process.argv.includes('--publish');
  const { errors, summary } = verifyReleasePackageBoundary({ root, publishMode });
  if (errors.length > 0) {
    console.error('Release package boundary verification failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
