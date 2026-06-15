import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildIDEAgentAnalysisPacketFromProjectContext,
  buildProjectContextMissionBriefing,
} from '@alembic/core/host-agent-workflows';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildHostAgentProjectContextAnalysis,
  selectProjectContextDimensions,
} from '../../lib/runtime/mcp/host-agent-workflows/project-context-analysis.js';

const tempRoots: string[] = [];

describe('Host Agent ProjectContext direct switch', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it('builds briefing and IDEAgentAnalysis from ProjectContext results directly', async () => {
    const projectRoot = await createTinyTypeScriptProject();
    const analysis = await buildHostAgentProjectContextAnalysis({
      maxFileDetails: 2,
      maxFiles: 20,
      maxModuleDetails: 1,
      maxModuleSeeds: 2,
      projectRoot,
      source: 'codex-host-bootstrap',
    });
    const dimensions = selectProjectContextDimensions(analysis.dimensions).slice(0, 2);

    expect(analysis.requestKinds).toEqual(
      expect.arrayContaining(['space', 'repo', 'map', 'module', 'file-flow', 'file-symbols'])
    );
    expect(analysis.presenterInput.project.projectRoot).toBe(projectRoot);
    expect(analysis.presenterInput.files.map((file) => file.filePath)).toContain('src/index.ts');

    const session = {
      toJSON: () => ({ id: 'session-project-context' }),
    };
    const briefing = buildProjectContextMissionBriefing({
      activeDimensions: dimensions,
      profile: 'cold-start-host-agent',
      projectContext: analysis.presenterInput,
      session,
    });
    const packet = buildIDEAgentAnalysisPacketFromProjectContext({
      dimensions,
      options: { profile: 'cold-start', projectRoot },
      projectContext: analysis.presenterInput,
    });

    expect(briefing.meta?.projectInformationSource).toBe('project-context');
    expect(briefing.projectContext).toMatchObject({ source: 'project-context' });
    expect(packet.meta.source).toBe('project-context');
    expect(packet.retrievalHints.structureTools).toContain('ProjectContext.execute');
    expect(JSON.stringify({ briefing, packet })).not.toMatch(/sourceGraph|panoramaResult/);
  });

  it('keeps Plugin cold-start and rescan workflows off old project-information carriers', async () => {
    const workflowText = await Promise.all([
      readWorkflow('cold-start.ts'),
      readWorkflow('knowledge-rescan.ts'),
    ]);
    const combined = workflowText.join('\n');

    expect(combined).not.toContain('ProjectIntelligenceCapability');
    expect(combined).not.toContain('buildProjectSnapshot');
    expect(combined).not.toContain('ProjectSnapshot');
    expect(combined).not.toContain('buildIDEAgentAnalysisPacketFromSnapshot');
    expect(combined).not.toContain('normalizePanoramaForIDEAgent');
    expect(combined).not.toContain('@alembic/core/workflows/capabilities/project-intelligence');
  });
});

async function createTinyTypeScriptProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'alembic-project-context-direct-'));
  tempRoots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'project-context-direct-test',
        scripts: { test: 'node --test' },
        type: 'module',
      },
      null,
      2
    )
  );
  await writeFile(
    join(root, 'src', 'index.ts'),
    [
      "import { formatName } from './util.js';",
      '',
      'export function run(name: string): string {',
      '  return formatName(name);',
      '}',
      '',
    ].join('\n')
  );
  await writeFile(
    join(root, 'src', 'util.ts'),
    [
      'export function formatName(name: string): string {',
      '  return name.trim().toUpperCase();',
      '}',
      '',
    ].join('\n')
  );
  return root;
}

function readWorkflow(fileName: string): Promise<string> {
  return readFile(
    join(process.cwd(), 'lib', 'runtime', 'mcp', 'host-agent-workflows', fileName),
    'utf8'
  );
}
