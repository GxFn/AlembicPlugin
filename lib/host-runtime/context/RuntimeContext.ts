import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { getPackageVersion, PACKAGE_ROOT } from '../../shared/package-assets.js';

export const CODEX_PLUGIN_NAME = 'alembic';
// Shell directory keeps its host-descriptive name; only the distribution
// identity was unified to "alembic" (naming ruling 2026-06-13, D1/D4).
export const CODEX_PLUGIN_SHELL_DIR = 'alembic-codex';
export const CODEX_RUNTIME_PACKAGE = '@gxfn/alembic-runtime';
export const CODEX_RUNTIME_BIN = 'alembic-codex-mcp';
export const CODEX_MARKETPLACE_SHELL_ENTRY = './bin/alembic-start.mjs';
export const CODEX_SETUP_PROFILE = 'codex-plugin';
export const DEFAULT_MCP_TIER = 'agent';
export const ALEMBIC_RUNTIME_MODE_ENV = 'ALEMBIC_RUNTIME_MODE';
export const ALEMBIC_RUNTIME_MODE_PLUGIN = 'plugin';
export const ALEMBIC_PLUGIN_HOST_ENV = 'ALEMBIC_PLUGIN_HOST';
export const CODEX_PLUGIN_HOST = 'codex';
// RC-1: claude-code shell 的 host 标识，对称 CODEX_PLUGIN_HOST；双宿主下 host
// identity 由物理 shell 形态派生，消除恒为 codex 的硬编码默认。
export const CLAUDE_CODE_PLUGIN_HOST = 'claude-code';
export const MCP_MODE_ENV = 'ALEMBIC_MCP_MODE';
export const CODEX_MCP_SHIM_ENV = 'ALEMBIC_CODEX_MCP_MODE';
export const MCP_TIER_ENV = 'ALEMBIC_MCP_TIER';
export const CODEX_ADMIN_ENABLE_ENV = 'ALEMBIC_CODEX_ENABLE_ADMIN';
export const CODEX_PLUGIN_ROOT_ENV = 'ALEMBIC_CODEX_PLUGIN_ROOT';
export const CODEX_EMBEDDED_RUNTIME_SPECIFIER = `${CODEX_RUNTIME_PACKAGE}@0.2.0`;

export interface HostRuntimeContext {
  adminEnabled: boolean;
  defaultTier: string;
  effectiveTier: string;
  expectedPluginHost: string;
  expectedRuntimeMode: string;
  marketplacePath: string;
  packageRoot: string;
  packageVersion: string;
  embeddedRuntimeSpecifier: string;
  pinnedRuntimeSpecifier: string;
  pluginHost: string;
  pluginRoot: string;
  requestedTier: string;
  runtimeBin: string;
  runtimeMode: string;
  runtimePackage: string;
}

export function ensureRuntimeEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  env[ALEMBIC_RUNTIME_MODE_ENV] = env[ALEMBIC_RUNTIME_MODE_ENV] || ALEMBIC_RUNTIME_MODE_PLUGIN;
  // RC-1: host 未显式声明时按物理 shell 形态回退（cc→claude-code、codex→codex），
  // 不再硬编码 codex；env 已声明时短路、不触发 shell 探测。
  env[ALEMBIC_PLUGIN_HOST_ENV] =
    env[ALEMBIC_PLUGIN_HOST_ENV] ||
    derivePluginHostFromShape(detectPluginHostShape(resolveCodexPluginRoot(env)));
  env[MCP_MODE_ENV] = '1';
  env[CODEX_MCP_SHIM_ENV] = '1';
  env[MCP_TIER_ENV] = env[MCP_TIER_ENV] || DEFAULT_MCP_TIER;
}

export function resolveHostRuntimeContext(
  env: NodeJS.ProcessEnv = process.env
): HostRuntimeContext {
  const packageVersion = getPackageVersion();
  const requestedTier = env[MCP_TIER_ENV] || DEFAULT_MCP_TIER;
  const adminEnabled = env[CODEX_ADMIN_ENABLE_ENV] === '1';
  const effectiveTier = resolveEffectiveTier(requestedTier, adminEnabled);
  const pluginRoot = resolveCodexPluginRoot(env);
  // RC-1: expectedPluginHost 与 pluginHost 回退均由物理 shell 形态派生
  // （codex shell→codex、claude-code shell→claude-code），取代恒为 codex 的硬编码，
  // 使诊断按真实 shell 校验运行时 host（cc 运行时自认 claude-code）。
  const expectedPluginHost = derivePluginHostFromShape(detectPluginHostShape(pluginRoot));
  return {
    adminEnabled,
    defaultTier: DEFAULT_MCP_TIER,
    effectiveTier,
    expectedPluginHost,
    expectedRuntimeMode: ALEMBIC_RUNTIME_MODE_PLUGIN,
    marketplacePath: join(PACKAGE_ROOT, '.agents', 'plugins', 'marketplace.json'),
    packageRoot: PACKAGE_ROOT,
    packageVersion,
    embeddedRuntimeSpecifier: CODEX_EMBEDDED_RUNTIME_SPECIFIER,
    pinnedRuntimeSpecifier: `${CODEX_RUNTIME_PACKAGE}@${packageVersion}`,
    pluginHost: normalizeRuntimeIdentity(env[ALEMBIC_PLUGIN_HOST_ENV]) || expectedPluginHost,
    pluginRoot,
    requestedTier,
    runtimeBin: CODEX_RUNTIME_BIN,
    runtimeMode:
      normalizeRuntimeIdentity(env[ALEMBIC_RUNTIME_MODE_ENV]) || ALEMBIC_RUNTIME_MODE_PLUGIN,
    runtimePackage: CODEX_RUNTIME_PACKAGE,
  };
}

function resolveCodexPluginRoot(env: NodeJS.ProcessEnv): string {
  const configured = env[CODEX_PLUGIN_ROOT_ENV]?.trim();
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }
  return join(PACKAGE_ROOT, 'plugins', CODEX_PLUGIN_SHELL_DIR);
}

// RC-1: 物理 shell 形态探测（host identity 的权威来源）。codex shell 旁挂
// .mcp.json；claude-code shell 把 mcpServers 内联进 .claude-plugin/plugin.json
// 且无 .mcp.json。PluginRegistry 复用同一探测，避免两处形态判定漂移。
export function detectPluginHostShape(pluginRoot: string): 'codex' | 'claude-code' {
  const mcpPath = join(pluginRoot, '.mcp.json');
  const claudeManifestPath = join(pluginRoot, '.claude-plugin', 'plugin.json');
  // 仅“无 .mcp.json 且存在 claude-code manifest”判为 claude-code；其余（含两者
  // 皆缺的 fallback）保持历史 codex 形态，避免改变既有 Codex 运行时行为。
  if (!existsSync(mcpPath) && existsSync(claudeManifestPath)) {
    return 'claude-code';
  }
  return 'codex';
}

// RC-1: 由 shell 形态派生 host 标识，集中消除散落的硬编码 codex 默认。
export function derivePluginHostFromShape(hostShape: 'codex' | 'claude-code'): string {
  return hostShape === 'claude-code' ? CLAUDE_CODE_PLUGIN_HOST : CODEX_PLUGIN_HOST;
}

export function resolveEffectiveTier(tierName: string, adminEnabled: boolean): string {
  if (tierName === 'admin' && !adminEnabled) {
    return DEFAULT_MCP_TIER;
  }
  return tierName || DEFAULT_MCP_TIER;
}

function normalizeRuntimeIdentity(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}
