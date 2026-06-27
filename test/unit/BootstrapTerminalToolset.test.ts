import { afterEach, describe, expect, test, vi } from 'vitest';

const envBackup = { ...process.env };

afterEach(() => {
  process.env = { ...envBackup };
  vi.resetModules();
});

async function loadModule() {
  return await import('@alembic/core/host-agent-workflows');
}

function mockTerminalToolset(toolset = 'terminal-run') {
  process.env.ALEMBIC_TERMINAL_TOOLSET = toolset;
}

describe('BootstrapTerminalToolset', () => {
  test('defaults to terminal-run', async () => {
    delete process.env.ALEMBIC_TERMINAL_TOOLSET;
    mockTerminalToolset();

    const { resolveBootstrapTerminalToolset, getBootstrapStageTerminalTools } = await loadModule();
    const config = resolveBootstrapTerminalToolset();

    expect(config).toEqual({
      enabled: true,
      toolset: 'terminal-run',
      modes: ['run'],
    });
    expect(getBootstrapStageTerminalTools('analyze', config)).toEqual(['terminal']);
    expect(getBootstrapStageTerminalTools('produce', config)).toEqual([]);
  });

  test('allows explicit baseline to disable terminal tools', async () => {
    mockTerminalToolset('baseline');
    const { resolveBootstrapTerminalToolset, getBootstrapStageTerminalTools } = await loadModule();
    const config = resolveBootstrapTerminalToolset();

    expect(config).toEqual({
      enabled: false,
      toolset: 'baseline',
      modes: [],
    });
    expect(getBootstrapStageTerminalTools('analyze', config)).toEqual([]);
  });

  test.each([
    'terminal-shell',
    'terminal-pty',
  ])('collapses legacy %s requests to live terminal-run', async (toolset) => {
    mockTerminalToolset(toolset);
    const {
      buildBootstrapTerminalPolicyHints,
      getBootstrapStageTerminalTools,
      resolveBootstrapTerminalToolset,
    } = await loadModule();
    const config = resolveBootstrapTerminalToolset();
    const hints = buildBootstrapTerminalPolicyHints(config);

    expect(config).toEqual({
      enabled: true,
      toolset: 'terminal-run',
      modes: ['run'],
    });
    expect(getBootstrapStageTerminalTools('analyze', config)).toEqual(['terminal']);
    expect(getBootstrapStageTerminalTools('evolution', config)).toEqual(['terminal']);
    expect(JSON.stringify(hints)).not.toContain('terminal_shell');
    expect(JSON.stringify(hints)).not.toContain('terminal_pty');
  });

  test('removes retired terminal ids from workflow report projections', async () => {
    mockTerminalToolset('terminal-pty');
    const { buildWorkflowReport } = await loadModule();

    const report = buildWorkflowReport({
      sessionId: 'session-terminal-cleanup',
      projectInfo: { name: 'fixture', fileCount: 1, lang: 'ts' },
      dimensionStats: {
        architecture: {
          diagnostics: {
            stageToolsets: [
              {
                stage: 'analyze',
                source: 'bootstrap',
                allowedToolIds: ['terminal', 'terminal_shell', 'terminal_pty', 'code.read'],
              },
            ],
            toolCalls: [
              { tool: 'terminal_shell', status: 'success', ok: true, durationMs: 5 },
              { tool: 'terminal_pty', status: 'success', ok: true, durationMs: 5 },
              { tool: 'terminal', status: 'success', ok: true, durationMs: 5 },
            ],
          },
        },
      },
      candidateResults: { created: 0, failed: 0, errors: [] },
      skillResults: { created: 0, failed: 0, errors: [] },
      consolidationResult: null,
      skippedDims: [],
      incrementalSkippedDims: [],
      isIncremental: false,
      incrementalPlan: null,
      totalTimeMs: 1_000,
      totalTokenUsage: { input: 0, output: 0 },
      totalToolCalls: 3,
    });

    const stageToolsets = report.stageToolsets as Array<{ allowedToolIds: string[] }>;
    const terminal = report.terminal as { commands: Array<{ tool: string }> };

    expect(report.session?.terminalCapability).toBe('terminal-run');
    expect(stageToolsets[0]?.allowedToolIds).toEqual(['terminal', 'code.read']);
    expect(terminal.commands.map((command) => command.tool)).toEqual(['terminal']);
    expect(JSON.stringify(stageToolsets)).not.toContain('terminal_shell');
    expect(JSON.stringify(stageToolsets)).not.toContain('terminal_pty');
    expect(JSON.stringify(terminal)).not.toContain('terminal_shell');
    expect(JSON.stringify(terminal)).not.toContain('terminal_pty');
  });
});
