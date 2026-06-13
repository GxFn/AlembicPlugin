import path from 'node:path';
import {
  DEFAULT_FOLDER_NAMES,
  resolveFolderNames,
  validateFolderNameSegment,
} from '@alembic/core/workspace';
import { describe, expect, test } from 'vitest';
import {
  CONFIG_DIR,
  INTERNAL_SKILLS_DIR,
  PACKAGE_ROOT,
  PACKAGE_SKILLS_DIR,
  RESOURCES_DIR,
  TEMPLATES_DIR,
} from '../../lib/shared/package-assets.js';

describe('folder names', () => {
  test('defines the default folder names used by Alembic path resolvers', () => {
    expect(DEFAULT_FOLDER_NAMES.package).toMatchObject({
      config: 'config',
      dashboard: 'dashboard',
      internalSkills: 'skills',
      resources: 'resources',
      templates: 'templates',
    });
    expect(Object.keys(DEFAULT_FOLDER_NAMES.package).sort()).toEqual([
      'config',
      'dashboard',
      'internalSkills',
      'resources',
      'templates',
    ]);
    expect(DEFAULT_FOLDER_NAMES.project).toMatchObject({
      cache: 'cache',
      knowledgeBase: 'Alembic',
      runtime: '.asd',
      skills: 'skills',
    });
  });

  test('merges partial overrides without dropping defaults', () => {
    const names = resolveFolderNames({
      dev: { scratch: 'tmp-scratch' },
      package: { internalSkills: 'product-skills' },
      project: { skills: 'project-skills' },
    });

    expect(names.package.internalSkills).toBe('product-skills');
    expect(names.dev.scratch).toBe('tmp-scratch');
    expect(names.dev.chainRuns).toBe('chain-runs');
    expect(names.project.skills).toBe('project-skills');
    expect(names.project.knowledgeBase).toBe('Alembic');
  });

  test('rejects invalid folder name segments', () => {
    const invalidNames = ['', ' skills', 'skills ', '.', '..', 'a/b', 'a\\b', '~/skills'];

    for (const invalidName of invalidNames) {
      expect(() => validateFolderNameSegment(invalidName, 'test.path')).toThrow(Error);
    }
  });

  test('validates override values while resolving folder names', () => {
    expect(() => resolveFolderNames({ package: { internalSkills: '../skills' } })).toThrow(Error);
  });

  test('derives package paths from the shared default folder names', () => {
    expect(CONFIG_DIR).toBe(path.join(PACKAGE_ROOT, 'config'));
    expect(PACKAGE_SKILLS_DIR).toBe(path.join(PACKAGE_ROOT, 'skills'));
    expect(INTERNAL_SKILLS_DIR).toBe(path.join(PACKAGE_ROOT, 'skills'));
    expect(TEMPLATES_DIR).toBe(path.join(PACKAGE_ROOT, 'templates'));
    expect(RESOURCES_DIR).toBe(path.join(PACKAGE_ROOT, 'resources'));
  });
});
