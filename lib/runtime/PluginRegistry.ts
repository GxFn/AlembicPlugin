import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectPluginHostShape,
  type HostRuntimeContext,
  resolveHostRuntimeContext,
} from '../runtime/runtime/RuntimeContext.js';
import { hostAdapterForShape } from './host-adapter/resolveHostAdapter.js';

export const CODEX_REQUIRED_SKILLS = [
  'alembic',
  'alembic-create',
  'alembic-guard',
  'alembic-recipes',
  'alembic-structure',
] as const;

export interface JsonReadResult {
  ok: boolean;
  path: string;
  value: Record<string, unknown> | null;
}

export type CodexPluginHostShape = 'codex' | 'claude-code';

export interface CodexPluginMcpDeclaration {
  args: string[];
  hostShape: CodexPluginHostShape;
  json: JsonReadResult;
  server: Record<string, unknown> | null;
}

export interface CodexPluginRegistry {
  context: HostRuntimeContext;
  marketplace: JsonReadResult;
  mcp: {
    args: string[];
    env: Record<string, unknown> | null;
    json: JsonReadResult;
    server: Record<string, unknown> | null;
  };
  plugin: {
    assets: string[];
    hostShape: CodexPluginHostShape;
    manifest: JsonReadResult;
    readme: string;
    readmePath: string;
    root: string;
  };
}

/**
 * Single source for the per-host MCP declaration shape. The Codex shell ships
 * `.mcp.json` next to `.codex-plugin/plugin.json`; the Claude Code shell
 * declares `mcpServers` inline in `.claude-plugin/plugin.json` (spec form
 * with `${CLAUDE_PLUGIN_ROOT}` paths). DH-3b: the per-host manifest path and the
 * `${CLAUDE_PLUGIN_ROOT}` normalization live on the L3 HostAdapter
 * (`pluginMcpManifestPath` / `normalizePluginMcpArg`), so this function carries no
 * host-name branch. The Codex adapter's path is `.mcp.json` and its arg
 * normalization is identity, so the read stays byte-for-byte the historical Codex
 * behavior — host-shape awareness must not move Codex wire bytes (F-V2-2).
 */
export function readCodexPluginMcpDeclaration(pluginRoot: string): CodexPluginMcpDeclaration {
  // DH-3b: hostShape 分支收口到 L3——形态检测（detectPluginHostShape）后经 adapter 取 per-host
  // 清单路径 + arg 归一化，本函数不再判 hostShape。codex .mcp.json 仍在此 byte-for-byte 读取，
  // 且 codex 的 normalizePluginMcpArg 为恒等，故 codex wire bytes 不变（F-V2-2）。
  const hostShape = detectPluginHostShape(pluginRoot);
  const adapter = hostAdapterForShape(hostShape);
  const json = readJsonObject(adapter.pluginMcpManifestPath(pluginRoot));
  const server = asPlainRecord(asPlainRecord(json.value?.mcpServers)?.alembic);
  const args = Array.isArray(server?.args)
    ? server.args
        .filter((arg): arg is string => typeof arg === 'string')
        .map((arg) => adapter.normalizePluginMcpArg(arg))
    : [];
  return { args, hostShape, json, server };
}

export function loadCodexPluginRegistry(
  context: HostRuntimeContext = resolveHostRuntimeContext()
): CodexPluginRegistry {
  const mcpDeclaration = readCodexPluginMcpDeclaration(context.pluginRoot);
  // DH-3b: manifest 路径选择收口到 L3 adapter（不再判 hostShape）。
  const manifestPath = hostAdapterForShape(mcpDeclaration.hostShape).pluginManifestPath(
    context.pluginRoot
  );
  const readmePath = join(context.pluginRoot, 'README.md');
  const manifest = readJsonObject(manifestPath);
  const manifestInterface = asPlainRecord(manifest.value?.interface);

  return {
    context,
    marketplace: readJsonObject(context.marketplacePath),
    mcp: {
      args: mcpDeclaration.args,
      env: asPlainRecord(mcpDeclaration.server?.env),
      json: mcpDeclaration.json,
      server: mcpDeclaration.server,
    },
    plugin: {
      assets: collectManifestAssetPaths(manifestInterface),
      hostShape: mcpDeclaration.hostShape,
      manifest,
      readme: existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '',
      readmePath,
      root: context.pluginRoot,
    },
  };
}

export function readJsonObject(filePath: string): JsonReadResult {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return {
      ok: Boolean(parsed && typeof parsed === 'object'),
      path: filePath,
      value: asPlainRecord(parsed),
    };
  } catch {
    return { ok: false, path: filePath, value: null };
  }
}

export function collectManifestAssetPaths(
  manifestInterface: Record<string, unknown> | null
): string[] {
  const assets = [
    asString(manifestInterface?.composerIcon),
    asString(manifestInterface?.logo),
    ...(Array.isArray(manifestInterface?.screenshots)
      ? manifestInterface.screenshots.map((value) => asString(value))
      : []),
  ];
  return assets.filter((asset): asset is string => Boolean(asset));
}

export function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
