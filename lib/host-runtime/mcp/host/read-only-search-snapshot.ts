import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SNAPSHOT_PREFIX = 'alembic-search-read-';
const MAX_SNAPSHOT_ATTEMPTS = 3;

interface FileFingerprint {
  exists: boolean;
  hash?: string;
  mtimeNs?: string;
  size?: number;
}

export interface ReadOnlySearchSnapshot {
  configPath: string;
  dataRoot: string;
  databasePath: string;
  dispose(): void;
  root: string;
  vectorIndexPath: string;
}

interface SnapshotSource {
  destinationRelativePath: string;
  required?: boolean;
  sourcePath: string;
}

/**
 * Copy a stable read snapshot before SQLite or the vector runtime opens anything.
 *
 * A SQLite WAL reader may update the live `-shm` read marks even when opened readonly with
 * `query_only`. Search therefore fingerprints the whole live read family, copies the files into
 * an OS-temporary data root, and accepts the snapshot only when the source fingerprints stayed
 * identical across the copy interval. SQLite and HNSW may create private sidecars inside the
 * snapshot; disposal removes them after the request.
 */
export function createReadOnlySearchSnapshot(input: {
  dataRoot: string;
  databasePath: string;
}): ReadOnlySearchSnapshot {
  const vectorIndexPath = join(input.dataRoot, '.asd', 'context', 'index', 'vector_index.asvec');
  const sources: SnapshotSource[] = [
    {
      destinationRelativePath: join('.asd', 'alembic.db'),
      required: true,
      sourcePath: input.databasePath,
    },
    {
      destinationRelativePath: join('.asd', 'alembic.db-wal'),
      sourcePath: `${input.databasePath}-wal`,
    },
    {
      destinationRelativePath: join('.asd', 'config.json'),
      sourcePath: join(input.dataRoot, '.asd', 'config.json'),
    },
    {
      destinationRelativePath: join('.asd', 'context', 'index', 'vector_index.asvec'),
      sourcePath: vectorIndexPath,
    },
  ];
  const observedSources = [
    ...sources,
    {
      destinationRelativePath: join('.asd', 'alembic.db-shm'),
      sourcePath: `${input.databasePath}-shm`,
    },
  ];

  for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = captureFingerprints(observedSources);
    const missingRequired = sources.find(
      (source) => source.required && before[source.sourcePath]?.exists !== true
    );
    if (missingRequired) {
      throw new Error(
        `Read-only Search snapshot source is missing: ${missingRequired.sourcePath}.`
      );
    }

    const root = mkdtempSync(join(tmpdir(), SNAPSHOT_PREFIX));
    const dataRoot = join(root, 'data');
    try {
      for (const source of sources) {
        if (before[source.sourcePath]?.exists !== true) {
          continue;
        }
        const destination = join(dataRoot, source.destinationRelativePath);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(source.sourcePath, destination);
      }
      const after = captureFingerprints(observedSources);
      if (!fingerprintsEqual(before, after)) {
        process.stderr.write(
          `[MCP/Search] read snapshot raced with source activity; retrying attempt=${attempt}/${MAX_SNAPSHOT_ATTEMPTS}\n`
        );
        rmSync(root, { force: true, recursive: true });
        continue;
      }

      return {
        configPath: join(dataRoot, '.asd', 'config.json'),
        dataRoot,
        databasePath: join(dataRoot, '.asd', 'alembic.db'),
        dispose: () => rmSync(root, { force: true, recursive: true }),
        root,
        vectorIndexPath: join(dataRoot, '.asd', 'context', 'index', 'vector_index.asvec'),
      };
    } catch (err: unknown) {
      rmSync(root, { force: true, recursive: true });
      throw err;
    }
  }

  throw new Error(
    `Read-only Search could not capture a stable DB/WAL/vector snapshot after ${MAX_SNAPSHOT_ATTEMPTS} attempts.`
  );
}

function captureFingerprints(sources: readonly SnapshotSource[]): Record<string, FileFingerprint> {
  return Object.fromEntries(
    sources.map((source) => [source.sourcePath, fingerprint(source.sourcePath)])
  );
}

function fingerprint(filePath: string): FileFingerprint {
  if (!existsSync(filePath)) {
    return { exists: false };
  }
  const stat = statSync(filePath, { bigint: true });
  return {
    exists: true,
    hash: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
    mtimeNs: stat.mtimeNs.toString(),
    size: Number(stat.size),
  };
}

function fingerprintsEqual(
  left: Record<string, FileFingerprint>,
  right: Record<string, FileFingerprint>
): boolean {
  return Object.keys(left).every((filePath) => {
    const before = left[filePath];
    const after = right[filePath];
    return (
      before?.exists === after?.exists &&
      before?.hash === after?.hash &&
      before?.mtimeNs === after?.mtimeNs &&
      before?.size === after?.size
    );
  });
}
