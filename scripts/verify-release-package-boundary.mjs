#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const publishMode = process.argv.includes('--publish');
const legacyRootRegistryScript = ['release', 'package-boundary', 'publish'].join(':');
const packageJsonPath = join(root, 'package.json');
const rootConfigPath = join(root, 'config', 'default.json');
const releaseWorkflowPath = join(root, '.github', 'workflows', 'release.yml');
const runtimePackageJsonPath = join(root, 'plugins', 'alembic-codex', 'runtime', 'package.json');
const runtimeConfigPath = join(
  root,
  'plugins',
  'alembic-codex',
  'runtime',
  'config',
  'default.json'
);
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
const rootConfig = readJson(rootConfigPath);
const releaseWorkflowSource = existsSync(releaseWorkflowPath)
  ? readFileSync(releaseWorkflowPath, 'utf8')
  : '';
const runtimePackageJson = readJson(runtimePackageJsonPath);
const runtimeConfig = readJson(runtimeConfigPath);
const runtimeCoreSource = existsSync(runtimeCoreSourcePath)
  ? readJson(runtimeCoreSourcePath)
  : null;
const rootParentFileDependencies = collectFileParentDependencies(packageJson);
const errors = [];
const expectedRuntimePackageName = 'alembic-codex-plugin-runtime';

expect(
  packageJson.name === expectedRuntimePackageName,
  `root package identity must be ${expectedRuntimePackageName}`
);
expect(packageJson.private === true, 'root package must be private and unavailable to registry');
expect(
  !Object.hasOwn(rootConfig, 'ai'),
  'root config/default.json must not ship an AlembicPlugin-owned AI provider default'
);
expect(
  !Object.hasOwn(runtimeConfig, 'ai'),
  'embedded runtime config/default.json must not ship an AlembicPlugin-owned AI provider default'
);
expect(
  packageJson.dependencies?.['@alembic/core'] === 'file:../AlembicCore',
  'root package must keep local development dependency @alembic/core: file:../AlembicCore'
);
expect(
  runtimePackageJson.dependencies?.['@alembic/core'] === 'file:vendor/AlembicCore',
  'embedded runtime package must keep portable @alembic/core: file:vendor/AlembicCore'
);
expect(
  runtimePackageJson.name === expectedRuntimePackageName,
  `embedded runtime package identity must be ${expectedRuntimePackageName}`
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
    `${legacyReleaseAlias} must fail closed through the artifact-only root publication guard`
  );
}
expect(
  !packageJson.scripts?.[legacyRootRegistryScript],
  'legacy root registry publication script must be removed'
);
expect(Boolean(releaseWorkflowSource), 'Release workflow must exist');
expect(
  !/\bnpm\s+publish\b/.test(releaseWorkflowSource),
  'Release workflow must not invoke the root package registry publication command'
);
expect(
  releaseWorkflowSource.includes('actions/upload-artifact'),
  'Release workflow must upload Codex plugin artifacts instead of publishing the root package'
);
expect(
  releaseWorkflowSource.includes('plugins/alembic-codex/runtime.tgz'),
  'Release workflow must keep runtime.tgz as the portable plugin runtime artifact'
);

if (publishMode) {
  errors.push(
    [
      'Blocked root registry publication: AlembicPlugin is artifact-only.',
      'Publish Codex plugin snapshots through the channel, marketplace, and portable runtime artifact release path.',
      'The root package is intentionally private; runtime.tgz is the portable runtime artifact.',
      'The embedded Codex runtime must continue to use @alembic/core: file:vendor/AlembicCore.',
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
      private: packageJson.private === true,
      rootParentFileDependencies,
      rootRegistryPublish: 'disabled',
      codexPluginArtifactRelease: true,
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
