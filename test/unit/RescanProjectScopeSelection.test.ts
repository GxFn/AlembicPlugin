import path from 'node:path';
import { createProjectDescriptor } from '@alembic/core/shared';
import { describe, expect, test } from 'vitest';
import { selectRescanProjectScopeFolders } from '../../lib/recipe-pipeline/generate/rescan-project-scope.js';

describe('rescan ProjectScope selection', () => {
  test('intersects workspace folders with confirmed moduleScope', () => {
    const controlRoot = path.resolve('/tmp/alembic-workspace');
    const descriptor = createProjectDescriptor({
      controlRoot,
      dataRoot: path.join(controlRoot, '.ghost'),
      folders: ['Alembic', 'AlembicCore', 'AlembicPlugin', 'AlembicDashboard', 'BiliDili'].map(
        (name) => ({ displayName: name, id: `folder-${name}`, path: path.join(controlRoot, name) })
      ),
    });

    const selection = selectRescanProjectScopeFolders(descriptor, controlRoot, [
      'Alembic',
      'AlembicCore',
      'AlembicPlugin',
      'AlembicDashboard',
    ]);

    expect(selection.analysisProjectRoot).toBe(controlRoot);
    expect(selection.sourceFolders).toEqual([
      'Alembic',
      'AlembicCore',
      'AlembicPlugin',
      'AlembicDashboard',
    ]);
    expect(selection.folders.map((folder) => path.basename(folder.path))).not.toContain('BiliDili');
  });

  test('keeps a bound single-folder request inside that repository', () => {
    const controlRoot = path.resolve('/tmp/alembic-workspace');
    const pluginRoot = path.join(controlRoot, 'AlembicPlugin');
    const descriptor = createProjectDescriptor({
      controlRoot,
      dataRoot: path.join(controlRoot, '.ghost'),
      folders: [{ displayName: 'Plugin', id: 'folder-plugin', path: pluginRoot }],
    });

    expect(selectRescanProjectScopeFolders(descriptor, pluginRoot, ['lib/status'])).toEqual({
      analysisProjectRoot: pluginRoot,
      folders: [{ id: 'folder-plugin', path: pluginRoot }],
    });
  });
});
