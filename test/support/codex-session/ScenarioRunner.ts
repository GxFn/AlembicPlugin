import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type DaemonJobRecord, JobStore } from '@alembic/core/daemon';
import { analyzeScenarioResult, buildScenarioFacts } from './AgentOutputAnalyzer.js';
import { readScenarioSecretWritten, setupCodexScenarioFixture } from './Fixtures.js';
import { type AlembicMcpHarness, createCodexMcpHarness } from './McpHarness.js';
import type {
  CodexScenarioRunOptions,
  CodexScenarioStep,
  CodexSessionRunResult,
  CodexSessionScenario,
} from './ScenarioTypes.js';
import { TranscriptWriter } from './TranscriptWriter.js';

export async function runCodexSessionScenario(
  scenario: CodexSessionScenario,
  options: CodexScenarioRunOptions = {}
): Promise<CodexSessionRunResult> {
  const fixture = setupCodexScenarioFixture(scenario, options);
  const transcriptPath = path.join(fixture.runDir, 'transcript.jsonl');
  const resultPath = path.join(fixture.runDir, 'result.json');
  const runConfigPath = path.join(fixture.runDir, 'run-config.json');
  const summaryPath = path.join(fixture.runDir, 'summary.md');
  const transcript = new TranscriptWriter({
    filePath: transcriptPath,
    secrets: fixture.redactions,
  });
  let harness: AlembicMcpHarness | null = null;

  try {
    transcript.record({
      data: {
        alembicHome: fixture.config.alembicHome,
        alembicHomeMode: fixture.config.alembicHomeMode,
        expectedProjectRoot:
          scenario.fixture.projectRoot === 'explicit' ? fixture.projectRoot : null,
        projectRoot: fixture.projectRoot,
        projectRootMode: scenario.fixture.projectRoot || 'explicit',
        projectRootSource: fixture.config.projectRootSource,
        runDir: fixture.runDir,
        scenarioId: scenario.id,
        harnessMode: fixture.config.harnessMode,
      },
      type: 'run.started',
    });
    harness = createCodexMcpHarness({
      mode: fixture.config.harnessMode,
      projectRoot: fixture.projectRoot,
      scenario,
      transcript,
      waitUntilReadyMs: fixture.config.waitUntilReadyMs,
    });
    for (const [index, turn] of scenario.turns.entries()) {
      transcript.record({ text: turn.user, turn: index + 1, type: 'user.message' });
    }
    const scripted = resolveScenarioSteps(scenario);
    let assistantFinalText = '';
    for (const [index, step] of scripted.entries()) {
      const turn = Math.min(index + 1, Math.max(1, scenario.turns.length));
      const args = resolveStepArguments(step.arguments || {}, fixture.projectRoot);
      const result = await harness.callTool(turn, step.name, args);
      assistantFinalText =
        step.assistantFinalText ||
        buildMechanicalAssistantText({
          fixtureProjectRootMode: scenario.fixture.projectRoot || 'explicit',
          result,
          toolName: step.name,
        });
      transcript.record({ text: assistantFinalText, turn, type: 'assistant.final' });
    }
    if (fixture.config.harnessMode === 'live-local' && fixture.config.waitJobTimeoutMs > 0) {
      await waitForLiveJobs({
        harness,
        pollIntervalMs: fixture.config.jobPollIntervalMs,
        projectRoot: fixture.projectRoot,
        timeoutMs: fixture.config.waitJobTimeoutMs,
        transcript,
      });
    }

    const facts = buildScenarioFacts({
      assistantFinalText,
      harness,
      harnessMode: fixture.config.harnessMode,
      projectRoot: fixture.projectRoot,
      projectRootMode: scenario.fixture.projectRoot || 'explicit',
      projectRootSource: fixture.config.projectRootSource,
      redactions: fixture.redactions,
      secretWritten: readScenarioSecretWritten(fixture.projectRoot),
      transcriptPath,
    });
    const errors = analyzeScenarioResult({
      expectation: scenario.expect,
      facts,
      scenario,
      transcriptPath,
    });
    const result: CodexSessionRunResult = {
      errors,
      facts,
      runConfig: fixture.config,
      runConfigPath,
      resultPath,
      runDir: fixture.runDir,
      scenario,
      summaryPath,
      transcriptPath,
    };
    transcript.record({
      data: { errors, status: errors.length ? 'failed' : 'passed' },
      type: 'run.completed',
    });
    writeRunArtifacts(result);
    return result;
  } finally {
    harness?.restore();
    fixture.restore();
  }
}

export function loadCodexSessionScenarios(
  options: { filter?: string } = {}
): CodexSessionScenario[] {
  const filter = options.filter?.trim();
  if (filter && fs.existsSync(filter) && filter.endsWith('.json')) {
    return [JSON.parse(fs.readFileSync(filter, 'utf8')) as CodexSessionScenario];
  }
  const root = path.resolve('test/codex-scenarios');
  const files = listJsonFiles(root);
  const scenarios = files.map(
    (file) => JSON.parse(fs.readFileSync(file, 'utf8')) as CodexSessionScenario
  );
  const selected = filter
    ? scenarios.filter((scenario) => scenario.id === filter || scenario.id.includes(filter))
    : scenarios.filter((scenario) => !scenario.manual);
  return selected;
}

function resolveScenarioSteps(scenario: CodexSessionScenario): CodexScenarioStep[] {
  if (scenario.steps?.length) {
    return scenario.steps;
  }
  return (scenario.expect.toolCalls || []).map((call) => ({
    arguments: call.arguments || {},
    name: call.name,
  }));
}

function resolveStepArguments(
  args: Record<string, unknown>,
  projectRoot: string
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    resolved[key] = value === '$projectRoot' ? projectRoot : value;
  }
  return resolved;
}

function buildMechanicalAssistantText(input: {
  fixtureProjectRootMode: string;
  result: unknown;
  toolName: string;
}): string {
  if (input.toolName === 'alembic_mcp_status' && input.fixtureProjectRootMode === 'missing') {
    return 'Alembic 需要目标项目的绝对 projectRoot。当前 Codex 插件没有拿到可信项目目录，请提供项目根目录后再继续。';
  }
  if (input.toolName === 'alembic_mcp_init') {
    return isSuccess(input.result)
      ? 'Alembic Codex 初始化已完成。这里只完成工作区初始化，还没有开始知识挖掘。'
      : 'Alembic Codex 初始化没有完成，请查看工具返回的诊断信息后重试。';
  }
  if (input.toolName === 'alembic_bootstrap') {
    return isSuccess(input.result)
      ? 'Alembic Codex host-agent bootstrap 已启动。请按 Mission Briefing 分析项目、提交知识并完成维度。'
      : 'Alembic Codex host-agent bootstrap 没有启动，请查看工具返回的错误信息。';
  }
  if (input.toolName === 'alembic_rescan') {
    return isSuccess(input.result)
      ? 'Alembic Codex architecture rescan 已完成；请用 evidence checker 复核 preserved Recipe、evidencePlan 和 no duplicate。'
      : 'Alembic Codex architecture rescan 没有完成，请查看工具返回的错误信息。';
  }
  return isSuccess(input.result)
    ? `Codex session scenario step ${input.toolName} completed.`
    : `Codex session scenario step ${input.toolName} failed.`;
}

function isSuccess(result: unknown): boolean {
  return Boolean(
    result && typeof result === 'object' && (result as { success?: unknown }).success === true
  );
}

async function waitForLiveJobs(options: {
  harness: AlembicMcpHarness;
  pollIntervalMs: number;
  projectRoot: string;
  timeoutMs: number;
  transcript: TranscriptWriter;
}): Promise<void> {
  const jobIds = extractCreatedJobIds(options.harness.toolCalls);
  options.transcript.record({
    data: { jobIds, timeoutMs: options.timeoutMs },
    type: 'harness.live_job_wait.started',
  });
  if (jobIds.length === 0) {
    options.transcript.record({
      data: { reason: 'no bootstrap/rescan job id was returned' },
      type: 'harness.live_job_wait.skipped',
    });
    return;
  }

  const store = new JobStore({ projectRoot: options.projectRoot });
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    const jobs = jobIds.map((id) => store.get(id));
    const visibleJobs = jobs.filter((job): job is DaemonJobRecord => Boolean(job));
    options.transcript.record({
      data: {
        jobs: visibleJobs.map((job) => ({
          id: job.id,
          kind: job.kind,
          status: job.status,
          updatedAt: job.updatedAt,
        })),
        missingJobIds: jobIds.filter((id) => !visibleJobs.some((job) => job.id === id)),
      },
      type: 'harness.live_job_wait.poll',
    });
    if (
      visibleJobs.length === jobIds.length &&
      visibleJobs.every((job) => isTerminalJobStatus(job.status))
    ) {
      options.transcript.record({
        data: {
          jobs: visibleJobs.map((job) => ({
            completedAt: job.completedAt,
            error: job.error,
            id: job.id,
            kind: job.kind,
            status: job.status,
          })),
        },
        type: 'harness.live_job_wait.completed',
      });
      return;
    }
    await sleep(Math.max(250, options.pollIntervalMs));
  }
  options.transcript.record({
    data: { jobIds, timeoutMs: options.timeoutMs },
    type: 'harness.live_job_wait.timeout',
  });
}

function extractCreatedJobIds(toolCalls: AlembicMcpHarness['toolCalls']): string[] {
  const ids: string[] = [];
  for (const call of toolCalls) {
    if (call.name !== 'alembic_mcp_bootstrap_job' && call.name !== 'alembic_mcp_rescan_job') {
      continue;
    }
    const data =
      call.result && typeof call.result === 'object'
        ? (call.result as { data?: unknown }).data
        : null;
    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const jobId = typeof record.jobId === 'string' ? record.jobId : null;
    const job =
      record.job && typeof record.job === 'object' ? (record.job as Record<string, unknown>) : {};
    const nestedJobId = typeof job.id === 'string' ? job.id : null;
    const id = jobId || nestedJobId;
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

function isTerminalJobStatus(status: string): boolean {
  return status === 'cancelled' || status === 'completed' || status === 'failed';
}

function listJsonFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function writeRunArtifacts(result: CodexSessionRunResult): void {
  fs.writeFileSync(
    result.resultPath,
    `${JSON.stringify(
      {
        errors: result.errors,
        facts: result.facts,
        runConfig: result.runConfig,
        scenario: { id: result.scenario.id, description: result.scenario.description || '' },
        transcriptPath: result.transcriptPath,
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    result.summaryPath,
    [
      `# ${result.scenario.id}`,
      '',
      result.errors.length ? 'Status: failed' : 'Status: passed',
      '',
      `Project root: ${result.runConfig.projectRoot}`,
      `Project root source: ${result.runConfig.projectRootSource}`,
      `Harness mode: ${result.runConfig.harnessMode}`,
      `Alembic home mode: ${result.runConfig.alembicHomeMode}`,
      `Alembic home: ${result.runConfig.alembicHome}`,
      `Jobs: ${result.facts.jobs.latest.map((job) => `${job.id}:${job.status}`).join(', ') || 'none'}`,
      `Knowledge entries: ${result.facts.knowledgeArtifacts.database.totalEntries}`,
      `Candidate files: ${result.facts.knowledgeArtifacts.candidateFiles.length}`,
      `Recipe files: ${result.facts.knowledgeArtifacts.recipeFiles.length}`,
      '',
      `Transcript: ${result.transcriptPath}`,
      `Run config: ${result.runConfigPath}`,
      result.errors.length
        ? `\nErrors:\n${result.errors.map((error) => `- ${error}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  );
  fs.writeFileSync(result.runConfigPath, `${JSON.stringify(result.runConfig, null, 2)}\n`);
}
