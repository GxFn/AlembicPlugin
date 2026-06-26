#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const options = parseArgs(process.argv.slice(2));
const marketplace = readJson(join(projectRoot, '.agents', 'plugins', 'marketplace.json'));
const runtimePackage = readJson(join(projectRoot, 'packages', 'alembic-runtime', 'package.json'));
const runtimeSpecifier = `${runtimePackage.name}@${runtimePackage.version}`;
const pluginEntry = marketplace.plugins?.find((plugin) => plugin.name === 'alembic');
if (!pluginEntry) {
  throw new Error('.agents/plugins/marketplace.json is missing the alembic plugin entry');
}

const pluginRoot = join(projectRoot, pluginEntry.source?.path || '');
const pluginManifest = readJson(join(pluginRoot, '.codex-plugin', 'plugin.json'));
const codexHome = resolve(options.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'));
const marketplaceName = marketplace.name || 'gxfn';
const pluginName = pluginManifest.name || pluginEntry.name;
const pluginNameAliases = resolvePluginNameAliases();
const pluginVersion = pluginManifest.version;
if (!pluginVersion) {
  // cache 目录名必须跟随当前插件 manifest，缺失版本时直接失败，避免开发态同步落到旧版本槽位。
  throw new Error('Codex plugin cache sync requires a plugin manifest version.');
}
const localMcpEntry = resolve(
  options.localMcpEntry || join(projectRoot, 'dist', 'bin', 'host-mcp.js')
);
const localProjectionMarkerNames = [
  'releasedEmptySession',
  'coverageLedgerSeed',
  'noActionableHostAgentWork',
];
const localProjectionFiles = [
  {
    id: 'knowledge-rescan-runtime',
    kind: 'runtime-dist',
    path: join(
      projectRoot,
      'dist',
      'lib',
      'recipe-generation',
      'host-agent-workflows',
      'knowledge-rescan.js'
    ),
  },
  {
    id: 'knowledge-rescan-source',
    kind: 'source-lib',
    path: join(
      projectRoot,
      'lib',
      'recipe-generation',
      'host-agent-workflows',
      'knowledge-rescan.ts'
    ),
  },
];
const targetRoots = resolveTargetRoots();

// 开发态 cache 同步只操作 Codex 插件缓存，不修改仓库内发布 manifest。
if (options.dryRun) {
  printSummary({ dryRun: true });
  process.exit(0);
}

for (const targetRoot of targetRoots) {
  syncTarget(targetRoot);
}

printSummary({ dryRun: false });

function resolveTargetRoots() {
  const explicit = [];
  for (const target of options.targetRoots) {
    explicit.push(resolve(target));
  }
  if (options.marketplaceName) {
    explicit.push(
      join(codexHome, 'plugins', 'cache', options.marketplaceName, pluginName, pluginVersion)
    );
  }
  const defaultTarget = join(
    codexHome,
    'plugins',
    'cache',
    marketplaceName,
    pluginName,
    pluginVersion
  );
  explicit.push(defaultTarget);

  if (options.allInstalled) {
    for (const installed of findInstalledPluginRoots()) {
      explicit.push(installed);
    }
  }

  return [...new Set(explicit)];
}

function findInstalledPluginRoots() {
  const cacheRoot = join(codexHome, 'plugins', 'cache');
  if (!existsSync(cacheRoot)) {
    return [];
  }
  const found = [];
  for (const first of safeReaddir(cacheRoot)) {
    const firstPath = join(cacheRoot, first);
    if (!safeIsDirectory(firstPath)) {
      continue;
    }
    for (const second of safeReaddir(firstPath)) {
      const secondPath = join(firstPath, second);
      if (!safeIsDirectory(secondPath)) {
        continue;
      }
      for (const third of safeReaddir(secondPath)) {
        const candidate = join(secondPath, third);
        if (!safeIsDirectory(candidate)) {
          continue;
        }
        const manifestPath = join(candidate, '.codex-plugin', 'plugin.json');
        if (!existsSync(manifestPath)) {
          continue;
        }
        const manifest = readJson(manifestPath);
        const manifestName = typeof manifest.name === 'string' ? manifest.name : '';
        const manifestVersion = typeof manifest.version === 'string' ? manifest.version : '';
        if (
          manifestVersion === pluginVersion &&
          (pluginNameAliases.includes(manifestName) || pluginNameAliases.includes(second))
        ) {
          found.push(candidate);
        }
      }
    }
  }
  return found;
}

function resolvePluginNameAliases() {
  const aliases = new Set([pluginName, pluginEntry.name, basename(pluginRoot)]);
  const shellPackagePath = join(pluginRoot, 'package.json');
  if (existsSync(shellPackagePath)) {
    const shellPackage = readJson(shellPackagePath);
    if (typeof shellPackage.name === 'string' && shellPackage.name.length > 0) {
      aliases.add(shellPackage.name);
    }
  }
  return [...aliases].filter((alias) => typeof alias === 'string' && alias.length > 0);
}

function syncTarget(targetRoot) {
  const stagingRoot = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;
  rmSync(stagingRoot, { force: true, recursive: true });
  mkdirSync(dirname(stagingRoot), { recursive: true });
  cpSync(pluginRoot, stagingRoot, {
    force: true,
    recursive: true,
    filter(sourcePath) {
      return !sourcePath.split('/').includes('.git');
    },
  });

  if (options.localMcp) {
    rewriteCachedMcpForLocalDist(stagingRoot);
  }
  writeRefreshMarker(stagingRoot, targetRoot);

  if (options.clean || existsSync(targetRoot)) {
    rmSync(targetRoot, { force: true, recursive: true });
  }
  renameSync(stagingRoot, targetRoot);
}

function rewriteCachedMcpForLocalDist(cacheRoot) {
  if (!existsSync(localMcpEntry)) {
    throw new Error(`Local Codex MCP entry not found: ${localMcpEntry}. Run npm run build first.`);
  }

  const mcpPath = join(cacheRoot, '.mcp.json');
  const mcp = readJson(mcpPath);
  const serverNames = Object.keys(mcp.mcpServers || {});
  if (serverNames.length === 0) {
    throw new Error(`Cached MCP config has no mcpServers: ${mcpPath}`);
  }

  const serverName = serverNames.includes('alembic') ? 'alembic' : serverNames[0];
  const server = mcp.mcpServers[serverName] || {};
  const serverEnv = isRecord(server.env) ? server.env : {};
  mcp.mcpServers[serverName] = {
    ...server,
    command: process.execPath,
    args: [localMcpEntry],
    env: {
      ...serverEnv,
      ALEMBIC_PLUGIN_HOST: 'codex',
      ALEMBIC_CODEX_MCP_MODE: '1',
      ALEMBIC_MCP_MODE: '1',
      ALEMBIC_MCP_TIER: serverEnv.ALEMBIC_MCP_TIER || 'agent',
      ALEMBIC_RUNTIME_MODE: 'plugin',
    },
  };
  writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = {
    allInstalled: false,
    clean: false,
    codexHome: '',
    dryRun: false,
    localMcpEntry: '',
    localMcp: false,
    marketplaceName: '',
    targetRoots: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--clean') {
      parsed.clean = true;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--local-mcp') {
      parsed.localMcp = true;
    } else if (arg === '--all-installed') {
      parsed.allInstalled = true;
    } else if (arg === '--codex-home') {
      parsed.codexHome = args[index + 1] || '';
      index += 1;
    } else if (arg === '--local-mcp-entry') {
      parsed.localMcpEntry = args[index + 1] || '';
      index += 1;
    } else if (arg === '--marketplace-name') {
      parsed.marketplaceName = args[index + 1] || '';
      index += 1;
    } else if (arg === '--target-root') {
      parsed.targetRoots.push(args[index + 1] || '');
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function writeRefreshMarker(cacheRoot, targetRoot) {
  const marker = {
    schemaVersion: 1,
    refreshedAt: new Date().toISOString(),
    mode: options.localMcp ? 'local-mcp' : 'packaged-shell',
    entryMode: options.localMcp ? 'local-dev-direct-dist' : 'marketplace-shell',
    canonicalLocalDevCommand: 'npm run dev:codex-plugin:reload',
    sourceRoot: pluginRoot,
    targetRoot,
    packageVersion: readJson(join(projectRoot, 'package.json')).version,
    pluginVersion,
    gitHead: readGitHead(),
    localMcpEntry: options.localMcp ? localMcpEntry : null,
    runtimeModeSeparation: {
      localDev: {
        entryMode: 'local-dev-direct-dist',
        localMcpEntry: options.localMcp ? localMcpEntry : null,
        cacheRewrite: options.localMcp,
      },
      packaged: {
        entryMode: 'marketplace-shell',
        shellEntry: './bin/alembic-start.mjs',
        runtimeSpecifier,
        cacheIsolation: 'owned by the marketplace shell bootstrap path',
      },
    },
    localProjection: options.localMcp ? buildLocalProjectionMarker() : null,
    hashes: {
      mcp: hashFile(join(cacheRoot, '.mcp.json')),
      manifest: hashFile(join(cacheRoot, '.codex-plugin', 'plugin.json')),
      startup: hashFile(join(cacheRoot, 'bin', 'alembic-start.mjs')),
    },
  };
  writeFileSync(
    join(cacheRoot, '.alembic-dev-refresh.json'),
    `${JSON.stringify(marker, null, 2)}\n`
  );
}

function buildLocalProjectionMarker() {
  const files = localProjectionFiles.map((file) => {
    const content = existsSync(file.path) ? readFileSync(file.path, 'utf8') : '';
    const markerStatus = Object.fromEntries(
      localProjectionMarkerNames.map((marker) => [marker, content.includes(marker)])
    );
    const allRequiredMarkersPresent = Object.values(markerStatus).every(Boolean);
    return {
      ...file,
      exists: existsSync(file.path),
      bytes: existsSync(file.path) ? statSync(file.path).size : 0,
      hash: hashFile(file.path),
      requiredMarkers: localProjectionMarkerNames,
      markerStatus,
      allRequiredMarkersPresent,
    };
  });
  return {
    mode: 'local-dev-direct-dist',
    mcpEntry: {
      path: localMcpEntry,
      exists: existsSync(localMcpEntry),
      hash: hashFile(localMcpEntry),
    },
    requiredMarkerNames: localProjectionMarkerNames,
    files,
    allRequiredMarkersPresent: files.every((file) => file.allRequiredMarkersPresent),
  };
}

function hashFile(path) {
  if (!existsSync(path)) {
    return null;
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readGitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function printSummary(input) {
  const summary = {
    dryRun: input.dryRun,
    marketplaceName,
    pluginName,
    pluginNameAliases,
    pluginVersion,
    pluginRoot,
    targetRoots,
    clean: options.clean,
    ...(options.localMcp ? { localMcpEntry } : {}),
    localMcp: options.localMcp,
    allInstalled: options.allInstalled,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`Sync Alembic Codex plugin into the local Codex plugin cache.

Usage:
  node scripts/sync-codex-plugin-cache.mjs [options]

Options:
  --dry-run             Print target paths without writing.
  --clean               Remove the cached plugin version before copying.
  --all-installed       Also refresh installed alembic-codex cache roots with the same version.
  --local-mcp           Rewrite cached .mcp.json to run local dist/bin/host-mcp.js.
  --local-mcp-entry <path>
                        Override the local MCP entry used with --local-mcp.
  --codex-home <path>   Override CODEX_HOME, defaults to ~/.codex.
  --marketplace-name <name>
                        Refresh cache path for this marketplace name.
  --target-root <path>  Refresh this explicit installed plugin cache root.
  -h, --help            Show this help.
`);
}
