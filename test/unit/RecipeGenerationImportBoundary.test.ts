import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const RECIPE_GENERATION_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../lib/recipe-generation'
);

describe('recipe-generation import boundary', () => {
  test('lib/recipe-generation does not import ProjectContext service modules', () => {
    const offenders: Array<{ file: string; specifier: string }> = [];
    for (const file of listTypeScriptFiles(RECIPE_GENERATION_ROOT)) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (isProjectKnowledgeContextServiceSpecifier(specifier)) {
          offenders.push({ file: path.relative(RECIPE_GENERATION_ROOT, file), specifier });
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

function listTypeScriptFiles(root: string): string[] {
  const entries = readdirSync(root);
  return entries.flatMap((entry) => {
    const fullPath = path.join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      return listTypeScriptFiles(fullPath);
    }
    return fullPath.endsWith('.ts') ? [fullPath] : [];
  });
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importExportFrom =
    /^\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
  const sideEffectImport = /^\s*import\s+['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(importExportFrom)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }
  for (const match of source.matchAll(sideEffectImport)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function isProjectKnowledgeContextServiceSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('#service/project-knowledge-context') ||
    specifier.includes('/service/project-knowledge-context') ||
    specifier.includes('lib/service/project-knowledge-context')
  );
}
