#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const publishMode = process.argv.includes('--publish');
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
const runtimeSpecifier = `${runtimePackageJson.name}@${runtimePackageJson.version}`;

expect(
  packageJson.name === 'alembic-codex-plugin-runtime',
  'root package identity must remain the private development package'
);
expect(packageJson.private === true, 'root package must be private and unavailable to registry');
expect(
  runtimePackageJson.name === '@gxfn/alembic-runtime',
  'runtime package must be @gxfn/alembic-runtime'
);
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
expect(
  !/\bnpm\s+publish\b/.test(releaseWorkflowSource),
  'Release workflow must not publish the private root package'
);
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
      runtimeSpecifier,
      rootParentFileDependencies,
      rootRegistryPublish: 'disabled',
      codexPluginArtifactRelease: 'marketplace-shell',
      forbiddenShellArtifactsAbsent: true,
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
