/**
 * package-assets.ts — Plugin package asset path adapter.
 *
 * Core owns workspace/config primitives; this file only locates assets shipped
 * by the AlembicPlugin package itself.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_FOLDER_NAMES } from '@alembic/core/workspace';

const __dirname = import.meta.dirname;
const PLUGIN_RUNTIME_PACKAGE_NAMES = new Set([
  '@gxfn/alembic-runtime',
  'alembic-codex-plugin-runtime',
]);

function findPackageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string };
        if (pkg.name && PLUGIN_RUNTIME_PACKAGE_NAMES.has(pkg.name)) {
          return dir;
        }
      } catch {
        /* continue */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    '[Alembic] Could not locate Plugin package root. ' +
      `No ancestor directory contains a package.json with one of ${JSON.stringify([
        ...PLUGIN_RUNTIME_PACKAGE_NAMES,
      ])}.`
  );
}

export const PACKAGE_ROOT = findPackageRoot();

export function getPackageVersion(): string {
  try {
    const raw = readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const CONFIG_DIR = path.join(PACKAGE_ROOT, DEFAULT_FOLDER_NAMES.package.config);
export const PACKAGE_SKILLS_DIR = path.join(
  PACKAGE_ROOT,
  DEFAULT_FOLDER_NAMES.package.internalSkills
);
export const INTERNAL_SKILLS_DIR = PACKAGE_SKILLS_DIR;

export const TEMPLATES_DIR = path.join(PACKAGE_ROOT, DEFAULT_FOLDER_NAMES.package.templates);
export const RESOURCES_DIR = path.join(PACKAGE_ROOT, DEFAULT_FOLDER_NAMES.package.resources);
