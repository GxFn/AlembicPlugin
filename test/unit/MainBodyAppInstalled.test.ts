import { describe, expect, test } from 'vitest';
import { isMainBodyInstalledGlobally } from '../../lib/host-runtime/mcp/handlers/system.js';

// 主体 app 安装态直接问 npm（`npm ls -g alembic-ai`），不用"daemon 是否跑过"间接推断——
// 后者会把「没装」和「装了但从未启动」混为一谈。这里用注入 runner，不真的 spawn。
describe('isMainBodyInstalledGlobally（直接问 npm 装没装）', () => {
  test('npm ls -g 命中 alembic-ai → installed=true', async () => {
    const run = async (_command: string, args: string[]): Promise<string> => {
      expect(args).toEqual(['ls', '-g', 'alembic-ai', '--depth=0']);
      return '/usr/local/lib\n└── alembic-ai@0.3.0\n';
    };
    expect(await isMainBodyInstalledGlobally(run)).toBe(true);
  });

  test('未安装：npm ls -g 以非 0 退出（runner reject）→ installed=false', async () => {
    const run = async (): Promise<string> => {
      throw new Error('Command failed: npm ls -g alembic-ai (exit 1)');
    };
    expect(await isMainBodyInstalledGlobally(run)).toBe(false);
  });

  test('stdout 无包名（空全局）→ installed=false', async () => {
    const run = async (): Promise<string> => '/usr/local/lib\n└── (empty)\n';
    expect(await isMainBodyInstalledGlobally(run)).toBe(false);
  });
});
