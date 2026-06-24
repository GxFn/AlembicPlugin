import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALL_DIMENSION_IDS } from '@alembic/core/dimensions';
import { afterEach, describe, expect, test } from 'vitest';
import { routePlanTool } from '../../lib/recipe-generation/plan-tool.js';

interface PlanToolResponse {
  data?: Record<string, unknown>;
  errorCode?: string;
  message: string;
  success: boolean;
}

const allowedDraftFields = [
  'agentDecisionChecklist',
  'candidateDimensions',
  'nextActions',
  'operation',
  'projectInfoTree',
  'projectRoot',
] as const;

const forbiddenDraftFields = [
  'presenterInput',
  'envelopes',
  'sourceReports',
  'missionBriefing',
  'onboardingContract',
  'sop',
  'analysisGuide',
  'submissionSpec',
  'matchTopics',
  'weight',
] as const;

let fixtureRoots: string[] = [];

describe('alembic_plan draft two-block projector', () => {
  afterEach(() => {
    for (const root of fixtureRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    fixtureRoots = [];
  });

  test('returns only projectInfoTree, candidateDimensions, checklist, and nextActions', async () => {
    const projectRoot = createSmallSwiftProject();
    const draft = await callDraft(projectRoot, { maxBudget: 64 });

    expect(draft.success).toBe(true);
    expect(Object.keys(draft.data ?? {}).sort()).toEqual([...allowedDraftFields].sort());

    const tree = asRecord(draft.data?.projectInfoTree);
    expect(tree).toMatchObject({
      kind: 'project',
      primaryLanguage: 'swift',
      meta: {
        budgetBytes: 64 * 1024,
        truncated: false,
      },
    });
    expect(asArray(tree.children).length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(tree), 'utf8')).toBeLessThanOrEqual(64 * 1024);

    const candidateDimensions = asArray(draft.data?.candidateDimensions).map(asRecord);
    expect(candidateDimensions).toHaveLength(25);
    expect(candidateDimensions.map((dimension) => String(dimension.id))).toEqual([
      ...ALL_DIMENSION_IDS,
    ]);
    for (const dimension of candidateDimensions) {
      expect(typeof dimension.label).toBe('string');
      expect(['universal', 'language', 'framework']).toContain(dimension.layer);
      expect(typeof dimension.languageApplicable).toBe('boolean');
      expect(String(dimension.miningGuidance)).not.toHaveLength(0);
      for (const forbidden of forbiddenDraftFields) {
        expect(dimension).not.toHaveProperty(forbidden);
      }
    }

    const raw = JSON.stringify(draft.data);
    for (const forbidden of forbiddenDraftFields) {
      expect(raw).not.toContain(`"${forbidden}"`);
    }
  });

  test('truncates large projectInfoTree at the configured byte ceiling', async () => {
    const projectRoot = createLargeSwiftProject();
    const draft = await callDraft(projectRoot, { maxBudget: 8 });

    expect(draft.success).toBe(true);
    const tree = asRecord(draft.data?.projectInfoTree);
    expect(Buffer.byteLength(JSON.stringify(tree), 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(asRecord(tree.meta)).toMatchObject({
      budgetBytes: 8 * 1024,
      truncated: true,
    });
    expect(['modules', 'files', 'symbols']).toContain(asRecord(tree.meta).deliveredDepth);
    expect(Object.keys(asRecord(asRecord(tree.meta).omitted)).length).toBeGreaterThan(0);
    expect(asArray(tree.children).length).toBeGreaterThan(0);
  });
});

async function callDraft(
  projectRoot: string,
  hints: Record<string, unknown>
): Promise<PlanToolResponse> {
  return (await routePlanTool(createContext(), {
    operation: 'draft',
    projectRoot,
    hints,
  })) as PlanToolResponse;
}

function createContext() {
  return {
    actor: { role: 'unit-test', user: 'unit-test' },
    container: {
      get: (name: string) => {
        throw new Error(`unexpected service lookup ${name}`);
      },
      singletons: {},
    },
  };
}

function createSmallSwiftProject(): string {
  const root = createFixtureRoot('plan-draft-small-');
  writeFile(root, 'Package.swift', swiftPackageManifest('SmallPlanFixture'));
  writeFile(
    root,
    'Sources/App/AppView.swift',
    [
      'import SwiftUI',
      '',
      'public struct AppView: View {',
      '  public init() {}',
      '  public var body: some View { Text("Hello") }',
      '}',
      '',
    ].join('\n')
  );
  writeFile(
    root,
    'Sources/App/AppService.swift',
    [
      'public struct AppService {',
      '  public init() {}',
      '  public func load() -> String { "ready" }',
      '}',
      '',
    ].join('\n')
  );
  return root;
}

function createLargeSwiftProject(): string {
  const root = createFixtureRoot('plan-draft-large-');
  writeFile(root, 'Package.swift', swiftPackageManifest('LargePlanFixture'));
  for (let index = 0; index < 120; index += 1) {
    writeFile(
      root,
      `Sources/Feature${String(index).padStart(3, '0')}/Feature${index}.swift`,
      [
        'import Foundation',
        '',
        `public struct Feature${index} {`,
        `  public let id = "${index}"`,
        '  public init() {}',
        `  public func render() -> String { "feature-${index}" }`,
        '}',
        '',
      ].join('\n')
    );
  }
  return root;
}

function createFixtureRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureRoots.push(root);
  return root;
}

function swiftPackageManifest(name: string): string {
  return [
    '// swift-tools-version: 6.0',
    'import PackageDescription',
    `let package = Package(name: "${name}", targets: [.target(name: "App", path: "Sources")])`,
    '',
  ].join('\n');
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
