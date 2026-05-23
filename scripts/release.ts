#!/usr/bin/env node

/**
 * Alembic 发布辅助脚本
 * 用途：自动化 Codex 插件 artifact 发布前检查
 * 使用：node dist/scripts/release.js check
 *
 * Codex 插件 artifact 发布由 .github/workflows/release.yml 在 v* tag 推送后完成。
 * AlembicPlugin root package 保持 private，不走 registry 发布链路。
 * 历史 release:patch/minor/major alias 已 fail-closed，请使用 release:codex-plugin。
 */

import { execSync } from 'node:child_process';

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  bold: '\x1b[1m',
};

type ColorName = keyof typeof colors;

interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  ignoreError?: boolean;
  silent?: boolean;
}

function writeLine(message: string) {
  process.stdout.write(`${message}\n`);
}

function log(message: string, color: ColorName = 'reset') {
  const code = colors[color] ?? '';
  writeLine(`${code}${message}${colors.reset}`);
}

function success(message: string) {
  log(`✅ ${message}`, 'green');
}

function error(message: string) {
  log(`❌ ${message}`, 'red');
}

function warning(message: string) {
  log(`⚠️  ${message}`, 'yellow');
}

function info(message: string) {
  log(`ℹ️  ${message}`, 'blue');
}

function header(message: string) {
  log(`\n${'='.repeat(60)}`, 'bold');
  log(`  ${message}`, 'bold');
  log(`${'='.repeat(60)}`, 'bold');
}

function exec(command: string, options: ExecOptions = {}) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options,
    });
  } catch (err: unknown) {
    if (!options.ignoreError) {
      throw err;
    }
    return null;
  }
}

// 检查项
class ReleaseChecker {
  errors: string[] = [];
  warnings: string[] = [];

  // 检查 Git 状态
  checkGitStatus() {
    header('Git 状态检查');

    // 检查分支
    const branch = exec('git branch --show-current', { silent: true })?.trim();
    if (branch !== 'main' && branch !== 'master') {
      this.errors.push(`当前分支不是 main/master: ${branch}`);
      error(`当前分支: ${branch}`);
    } else {
      success(`当前分支: ${branch}`);
    }

    // 检查工作区
    const status = exec('git status --short', { silent: true });
    if (status?.trim()) {
      this.errors.push('工作区有未提交的变更');
      error('工作区不干净:');
    } else {
      success('工作区干净');
    }

    // 检查远程同步
    try {
      exec('git fetch origin', { silent: true });
      const behind = exec(`git rev-list HEAD..origin/${branch} --count`, {
        silent: true,
        ignoreError: true,
      })?.trim();
      if (behind && parseInt(behind, 10) > 0) {
        this.warnings.push(`本地落后远程 ${behind} 个提交`);
        warning(`需要先 pull: git pull origin ${branch}`);
      } else {
        success('与远程同步');
      }
    } catch (_err: unknown) {
      warning('无法检查远程同步状态');
    }
  }

  // 检查 Node.js 环境
  checkNodeEnvironment() {
    header('Node.js 环境检查');

    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0], 10);

    if (majorVersion < 22) {
      this.errors.push(`Node.js 版本过低: ${nodeVersion} (需要 >=22)`);
      error(`Node.js: ${nodeVersion}`);
    } else {
      success(`Node.js: ${nodeVersion}`);
    }

    success('发布配置: 使用 config/*.json 与 CI runtime overrides，不依赖本地 .env');
  }

  // 本地构建校验。真正的发布构建会在 GitHub Actions 中再次执行。
  buildArtifacts() {
    header('构建发布产物');

    try {
      info('构建 TypeScript...');
      exec('npm run build');
      success('TypeScript 构建成功');
    } catch (err: unknown) {
      this.errors.push('发布产物构建失败');
      error('发布产物构建失败');
      throw err;
    }
  }

  // 检查其他构建产物
  checkBuildArtifacts() {
    header('其他构建产物检查');
    success('No platform-specific binaries to check');
  }

  // 运行测试
  runTests() {
    header('运行测试');

    try {
      info('运行单元测试...');
      exec('npm run test:unit');
      success('单元测试通过');
    } catch (_err: unknown) {
      this.errors.push('单元测试失败');
      error('单元测试失败');
    }

    try {
      info('运行集成测试...');
      exec('npm run test:integration', {
        env: {
          ...process.env,
          ASD_DISABLE_WRITE_GUARD: '1',
          ASD_DISABLE_RATE_LIMIT: '1',
        },
      });
      success('集成测试通过');
    } catch (_err: unknown) {
      this.errors.push('集成测试失败');
      error('集成测试失败');
    }
  }

  // 总结
  summary() {
    header('检查总结');

    if (this.errors.length === 0 && this.warnings.length === 0) {
      success('所有检查通过，可以准备 Codex 插件 artifact 发布！');
      return true;
    }

    if (this.errors.length > 0) {
      error(`发现 ${this.errors.length} 个错误：`);
      this.errors.forEach((err, i) => {
        error(`  ${i + 1}. ${err}`);
      });
    }

    if (this.warnings.length > 0) {
      warning(`发现 ${this.warnings.length} 个警告：`);
      this.warnings.forEach((warn, i) => {
        warning(`  ${i + 1}. ${warn}`);
      });
    }

    return this.errors.length === 0;
  }
}

// 主函数
function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // 显示帮助
  if (!command || command === '--help' || command === '-h') {
    process.exit(0);
  }

  // 执行检查
  if (command === 'check') {
    const checker = new ReleaseChecker();
    checker.checkGitStatus();
    checker.checkNodeEnvironment();
    checker.checkBuildArtifacts();

    if (checker.summary()) {
      info('\n运行 `npm run test` 来执行完整测试');
      info('运行 `npm run release:codex-plugin` 检查 Codex 插件 artifact 发布就绪状态');
      info('如需 daemon smoke，运行 `npm run release:codex-plugin:daemon`');
      process.exit(0);
    } else {
      error('\n请修复错误后再试');
      process.exit(1);
    }
  }

  // 历史 root package 版本发布 alias 已禁用，避免误以为插件走 npm registry 发布。
  if (['patch', 'minor', 'major'].includes(command)) {
    error(
      `release:${command} 已禁用：AlembicPlugin root package 是 artifact-only，不走 npm registry 发布。`
    );
    info('请使用 `npm run release:codex-plugin` 检查 Codex 插件 artifact。');
    info('请使用 `npm run release:codex-channel` 检查 Codex channel metadata。');
    process.exit(1);
  }

  // 未知命令
  error(`未知命令: ${command}`);
  process.exit(1);
}

// 执行
main();
