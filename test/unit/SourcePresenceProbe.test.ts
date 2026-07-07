import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { probeSourcePresence } from '../../lib/host-runtime/status/SourcePresenceProbe.js';

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-source-presence-'));
}

function writeFile(projectRoot: string, relativePath: string): void {
  const filePath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'export const value = 1;\n');
}

describe('SourcePresenceProbe', () => {
  test('counts source files while excluding generated, dependency, and hidden folders', () => {
    const projectRoot = makeProjectRoot();
    writeFile(projectRoot, 'src/index.ts');
    writeFile(projectRoot, 'node_modules/pkg/index.ts');
    writeFile(projectRoot, '.hidden/hidden.ts');
    writeFile(projectRoot, 'Alembic/recipes/generated.ts');
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# docs\n');

    const presence = probeSourcePresence(projectRoot);

    expect(presence).toMatchObject({
      hasSource: true,
      sourceFileCount: 1,
      capped: false,
      unreadableDirectoryCount: 0,
    });
  });

  test('honors depth and early-stop limits', () => {
    const projectRoot = makeProjectRoot();
    for (let index = 0; index < 30; index += 1) {
      writeFile(projectRoot, `src/file-${index}.ts`);
    }
    writeFile(projectRoot, 'deep/a/b/c/d/e/f/g/h/i/deep.ts');

    const capped = probeSourcePresence(projectRoot, { sourceFileLimit: 25 });
    const shallow = probeSourcePresence(projectRoot, { maxDepth: 4, sourceFileLimit: 50 });
    const deep = probeSourcePresence(projectRoot, { maxDepth: 12, sourceFileLimit: 50 });

    expect(capped).toMatchObject({
      hasSource: true,
      sourceFileCount: 25,
      capped: true,
    });
    expect(shallow.sourceFileCount).toBe(30);
    expect(deep.sourceFileCount).toBe(31);
  });

  test('treats unreadable or missing directories as empty instead of throwing', () => {
    const projectRoot = makeProjectRoot();
    const missingRoot = path.join(projectRoot, 'missing');

    const presence = probeSourcePresence(missingRoot);

    expect(presence).toMatchObject({
      hasSource: false,
      sourceFileCount: 0,
      unreadableDirectoryCount: 1,
    });
  });
});
