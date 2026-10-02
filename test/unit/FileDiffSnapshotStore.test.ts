import { normalizeSnapshotPath } from '@alembic/core/test-fixtures';
import { describe, expect, it } from 'vitest';

describe('normalizeSnapshotPath', () => {
  it('prefers project-relative path derived from absolute file path', () => {
    const rel = normalizeSnapshotPath(
      {
        path: '/repo/Sources/Infrastructure/Networking/Middleware/AuthMiddleware.swift',
        relativePath: 'Middleware/AuthMiddleware.swift',
      },
      '/repo'
    );

    expect(rel).toBe('Sources/Infrastructure/Networking/Middleware/AuthMiddleware.swift');
  });

  it('falls back to scanner relativePath when absolute path is outside project', () => {
    const rel = normalizeSnapshotPath(
      {
        path: '/tmp/AuthMiddleware.swift',
        relativePath: 'Middleware/AuthMiddleware.swift',
      },
      '/repo'
    );

    expect(rel).toBe('Middleware/AuthMiddleware.swift');
  });
});
