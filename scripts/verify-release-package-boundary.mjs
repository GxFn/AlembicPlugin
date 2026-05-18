#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const publishMode = process.argv.includes('--publish');
const packageJsonPath = join(root, 'package.json');
const runtimePackageJsonPath = join(root, 'plugins', 'alembic-codex', 'runtime', 'package.json');
const runtimeCoreSourcePath = join(
  root,
  'plugins',
  'alembic-codex',
  'runtime',
  'vendor',
  'AlembicCore',
  '.alembic-source.json'
);

const packageJson = readJson(packageJsonPath);
const runtimePackageJson = readJson(runtimePackageJsonPath);
const runtimeCoreSource = existsSync(runtimeCoreSourcePath)
  ? readJson(runtimeCoreSourcePath)
  : null;
const rootParentFileDependencies = collectFileParentDependencies(packageJson);
const errors = [];

expect(
  packageJson.dependencies?.['@alembic/core'] === 'file:../AlembicCore',
  'root package must keep local development dependency @alembic/core: file:../AlembicCore'
);
expect(
  runtimePackageJson.dependencies?.['@alembic/core'] === 'file:vendor/AlembicCore',
  'embedded runtime package must keep portable @alembic/core: file:vendor/AlembicCore'
);
expect(Boolean(runtimeCoreSource), 'embedded runtime Core source metadata must exist');
if (runtimeCoreSource) {
  expect(
    typeof runtimeCoreSource.source === 'string' && runtimeCoreSource.source.length > 0,
    'embedded runtime Core source metadata must record source'
  );
  expect(
    /^[0-9a-f]{40}$/i.test(runtimeCoreSource.commit || ''),
    'embedded runtime Core source metadata must record a 40-character source commit'
  );
  expect(
    runtimeCoreSource.packageDependency === 'file:vendor/AlembicCore',
    'embedded runtime Core source metadata must record packageDependency: file:vendor/AlembicCore'
  );
}

expect(
  packageJson.scripts?.prepublishOnly ===
    'npm run release:package-boundary:publish && npm run release:codex-plugin',
  'prepublishOnly must run the package boundary publish gate before release:codex-plugin'
);

if (publishMode && rootParentFileDependencies.length > 0) {
  errors.push(
    [
      'Blocked npm publish: root package.json still contains workspace-local file dependencies.',
      ...rootParentFileDependencies.map(
        (dependency) => `- ${dependency.field}.${dependency.name}: ${dependency.value}`
      ),
      'Create a publish staging manifest with registry dependencies after the Core package baseline is accepted, or keep this release unpublished.',
      'The embedded Codex runtime may continue to use @alembic/core: file:vendor/AlembicCore.',
    ].join('\n')
  );
}

if (errors.length > 0) {
  console.error('Release package boundary verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      publishMode,
      rootPackage: `${packageJson.name}@${packageJson.version}`,
      rootParentFileDependencies,
      rootPublishBlocked: rootParentFileDependencies.length > 0,
      embeddedRuntimeCoreDependency: runtimePackageJson.dependencies?.['@alembic/core'],
      embeddedCoreSource: runtimeCoreSource,
    },
    null,
    2
  )}\n`
);

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

function expect(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
