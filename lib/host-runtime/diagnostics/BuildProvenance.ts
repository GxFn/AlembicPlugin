import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LoadedBuildProvenance {
  available: boolean;
  entryHashMatches: boolean | null;
  loadedEntryHash: string | null;
  manifest: Record<string, unknown> | null;
  manifestPath: string | null;
  reason: string | null;
  valid: boolean;
}

/**
 * Read provenance beside the module that is actually executing. This never
 * consults checkout HEAD, so status cannot accidentally describe a newer tree
 * than the loaded dist/cache artifact.
 */
export function readLoadedBuildProvenance(
  modulePath = fileURLToPath(import.meta.url)
): LoadedBuildProvenance {
  const manifestPath = findBuildManifest(dirname(modulePath));
  if (!manifestPath) {
    return unavailable('No .build-manifest.json was found beside the loaded runtime artifact.');
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const publicEntry = readString(manifest.publicEntry);
    const expectedEntryHash = readString(manifest.publicEntryHash);
    const entryPath = publicEntry
      ? resolve(dirname(manifestPath), publicEntry.replace(/^dist\//u, ''))
      : null;
    const loadedEntryHash = entryPath && existsSync(entryPath) ? hashFile(entryPath) : null;
    const entryHashMatches =
      expectedEntryHash && loadedEntryHash ? expectedEntryHash === loadedEntryHash : null;
    const required = [
      'pluginCommit',
      'coreCommit',
      'sourceHash',
      'distContentHash',
      'builtAt',
      'publicEntry',
      'publicEntryHash',
    ].every((field) => readString(manifest[field]) !== null);
    const valid =
      manifest.kind === 'AlembicDistBuildManifest' &&
      manifest.version === 2 &&
      required &&
      entryHashMatches === true;
    return {
      available: true,
      entryHashMatches,
      loadedEntryHash,
      manifest,
      manifestPath,
      reason: valid
        ? null
        : 'Loaded runtime provenance is incomplete or its public entry hash does not match.',
      valid,
    };
  } catch (error: unknown) {
    return {
      ...unavailable(
        error instanceof Error
          ? `Loaded build manifest could not be read: ${error.message}`
          : 'Loaded build manifest could not be read.'
      ),
      manifestPath,
    };
  }
}

function findBuildManifest(start: string): string | null {
  let current = resolve(start);
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(current, '.build-manifest.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function unavailable(reason: string): LoadedBuildProvenance {
  return {
    available: false,
    entryHashMatches: null,
    loadedEntryHash: null,
    manifest: null,
    manifestPath: null,
    reason,
    valid: false,
  };
}
