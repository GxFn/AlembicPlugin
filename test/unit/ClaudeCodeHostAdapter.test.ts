import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CLAUDE_CODE_PLUGIN_HOST,
  ClaudeCodeHostAdapter,
  CODEX_PLUGIN_HOST,
  CODEX_PLUGIN_ROOT_ENV,
  CodexHostAdapter,
  resolveCodexProjectRoot,
  resolveHostAdapter,
  resolveHostRuntimeContext,
} from '../../lib/runtime/index.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

// codex shell = 默认 pluginRoot（plugins/alembic-codex，有 .mcp.json）；cc shell = sibling
// plugins/alembic-claude-code（.claude-plugin/plugin.json、无 .mcp.json）。
function shellRoots(): { codexShellRoot: string; claudeShellRoot: string } {
  const codexShellRoot = resolveHostRuntimeContext().pluginRoot;
  const claudeShellRoot = join(codexShellRoot, '..', 'alembic-claude-code');
  return { codexShellRoot, claudeShellRoot };
}

describe('DH-3① host-aware HostAdapter selection', () => {
  test('selects ClaudeCodeHostAdapter on the Claude Code shell (cc self-identifies as claude-code)', () => {
    const { claudeShellRoot } = shellRoots();
    const env: NodeJS.ProcessEnv = { [CODEX_PLUGIN_ROOT_ENV]: claudeShellRoot };
    const adapter = resolveHostAdapter(env);

    expect(adapter).toBeInstanceOf(ClaudeCodeHostAdapter);
    expect(adapter.hostId).toBe(CLAUDE_CODE_PLUGIN_HOST);
    expect(adapter.resolveRuntimeContext(env).pluginHost).toBe(CLAUDE_CODE_PLUGIN_HOST);
  });

  test('selects CodexHostAdapter on the Codex shell (codex path unchanged)', () => {
    const { codexShellRoot } = shellRoots();
    const adapter = resolveHostAdapter({ [CODEX_PLUGIN_ROOT_ENV]: codexShellRoot });

    expect(adapter).toBeInstanceOf(CodexHostAdapter);
    expect(adapter.hostId).toBe(CODEX_PLUGIN_HOST);
  });

  test('defaults to CodexHostAdapter without an env override (codex shell; no regression)', () => {
    const adapter = resolveHostAdapter();

    expect(adapter).toBeInstanceOf(CodexHostAdapter);
    expect(adapter.hostId).toBe(CODEX_PLUGIN_HOST);
  });

  test('trusts CLAUDE_PROJECT_DIR as a project-root source (cc workspace no longer fail-closed)', () => {
    // RC-1 之前 cc 工作区 cwd 只能 fallback（fail-closed）；DH-3① 把 CLAUDE_PROJECT_DIR
    // 纳入可信候选。codex 不设此 env，故 codex 解析行为不变。
    const projectDir = mkdtempSync(join(tmpdir(), 'alembic-cc-projroot-'));
    tempRoots.push(projectDir);

    const resolution = resolveCodexProjectRoot({ env: { CLAUDE_PROJECT_DIR: projectDir } });

    expect(resolution.source).toBe('CLAUDE_PROJECT_DIR');
    expect(resolution.trust).toBe('trusted');
    expect(resolution.rejected).toBe(false);
    expect(resolution.path).toBe(projectDir);
  });
});
