import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, '..');

const coreCandidates = [
  { label: '../AlembicCore', path: resolve(repoRoot, '..', 'AlembicCore') },
  { label: 'vendor/AlembicCore', path: join(repoRoot, 'vendor', 'AlembicCore') },
];

export function resolveCoreSource(options = {}) {
  const requireDist = Boolean(options.requireDist);
  const candidate = coreCandidates.find((entry) => {
    if (!existsSync(join(entry.path, 'package.json'))) {
      return false;
    }
    if (requireDist && !existsSync(join(entry.path, 'dist'))) {
      return false;
    }
    return true;
  });

  if (!candidate) {
    const distMessage = requireDist ? ' with dist' : '';
    throw new Error(
      `Could not resolve local Core source${distMessage}. Expected ../AlembicCore first, then vendor/AlembicCore.`
    );
  }

  return withSourceDetails(candidate);
}

export function resolveCoreGrammarSource() {
  const candidates = [
    {
      label: '../AlembicCore/resources/grammars',
      path: join(resolveCoreSource().path, 'resources', 'grammars'),
    },
    {
      label: 'node_modules/@alembic/core/resources/grammars',
      path: join(repoRoot, 'node_modules', '@alembic', 'core', 'resources', 'grammars'),
    },
  ];

  const candidate = candidates.find((entry) => existsSync(entry.path));
  if (!candidate) {
    throw new Error(
      'Core grammar resources are missing. Expected ../AlembicCore/resources/grammars, vendor/AlembicCore/resources/grammars, or node_modules/@alembic/core/resources/grammars.'
    );
  }

  return withSourceDetails(candidate);
}

export function toRepoRelative(path) {
  const relativePath = relative(repoRoot, path);
  return relativePath.startsWith('..') ? path : relativePath;
}

export function withSourceDetails(source) {
  return {
    ...source,
    commit: readGitCommit(source.path),
  };
}

function readGitCommit(sourcePath) {
  const result = spawnSync('git', ['-C', sourcePath, 'rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}
