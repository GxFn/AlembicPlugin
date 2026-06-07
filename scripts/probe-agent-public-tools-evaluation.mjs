#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(import.meta.dirname, '..');
const requiredTools = [
  'alembic_intent',
  'alembic_prime',
  'alembic_work_start',
  'alembic_work_finish',
  'alembic_code_guard',
  'alembic_decision_record',
];
const forbiddenLegacyPrimaryWording = [
  'operation=prime',
  'operation=create',
  'operation=close',
  'Task and decision management (5 operations)',
  'primary action is `alembic_task`',
];

const options = parseArgs(process.argv.slice(2));
const tmpRoot = mkdtempSync(join(tmpdir(), 'afapi-stage6-public-tools-'));
const projectRoot = options.projectRoot || join(tmpRoot, 'project');
mkdirSync(projectRoot, { recursive: true });

const report = {
  ok: false,
  generatedAt: new Date().toISOString(),
  mode: 'afapi-stage6-agent-public-tools-installed-cache-readback',
  projectRoot,
  requiredTools,
  forbiddenLegacyPrimaryWording,
  targets: [],
};

try {
  const targets = resolveInstalledTargets();
  for (const targetRoot of targets) {
    try {
      report.targets.push(await probeTarget(targetRoot));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      report.targets.push({
        ok: false,
        targetRoot,
        error: error.message,
      });
    }
  }
  report.ok = report.targets.length > 0 && report.targets.every((target) => target.ok === true);
  writeReport();
  if (!report.ok) {
    process.exitCode = 1;
  }
} finally {
  if (!options.keepTmp) {
    rmSync(tmpRoot, { force: true, recursive: true });
  }
}

async function probeTarget(targetRoot) {
  const issues = [];
  const marker = readOptionalJson(join(targetRoot, '.alembic-dev-refresh.json'));
  const transportConfig = readMcpServerConfig(targetRoot);
  const stderr = [];
  const transport = new StdioClientTransport({
    command: transportConfig.command,
    args: transportConfig.args,
    cwd: targetRoot,
    env: sanitizeEnv({
      ...process.env,
      ...(transportConfig.env || {}),
      ALEMBIC_HOME: join(tmpRoot, `home-${report.targets.length}`),
      ALEMBIC_PROJECT_DIR: projectRoot,
      ALEMBIC_QUIET: '1',
      CODEX_WORKSPACE_DIR: projectRoot,
      INIT_CWD: projectRoot,
      PWD: projectRoot,
    }),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));

  const client = new Client({
    name: 'afapi-stage6-agent-public-tools-evaluation',
    version: '0.0.0',
  });
  try {
    await withTimeout(
      client.connect(transport, { timeout: options.mcpTimeoutMs }),
      options.mcpTimeoutMs + 2000,
      () => `MCP connect timed out for ${targetRoot}\n${stderr.join('')}`
    );

    const beforeInitTools = await listTools(client, stderr);
    const beforeInit = summarizeToolSurface(beforeInitTools.tools);
    for (const toolName of requiredTools) {
      expectIssue(
        issues,
        beforeInit.names.includes(toolName),
        `before init tools/list missing ${toolName}`
      );
      const description = beforeInit.descriptions[toolName] || '';
      expectIssue(
        issues,
        description.includes('Non-goal:'),
        `${toolName} description did not include Non-goal`
      );
      for (const forbidden of forbiddenLegacyPrimaryWording) {
        expectIssue(
          issues,
          !description.includes(forbidden),
          `${toolName} description contains legacy primary wording: ${forbidden}`
        );
      }
    }
    expectIssue(
      issues,
      !beforeInit.names.includes('alembic_task'),
      'before init should not expose legacy alembic_task'
    );

    const calls = await runPublicToolCalls(client, stderr);
    evaluateCalls(issues, calls);

    const init = await callJsonTool(client, 'alembic_codex_init', { projectRoot }, stderr);
    expectIssue(issues, init.payload?.success === true, 'alembic_codex_init did not succeed');
    const afterInitTools = await listTools(client, stderr);
    const afterInit = summarizeToolSurface(afterInitTools.tools);
    expectIssue(
      issues,
      !afterInit.names.includes('alembic_task'),
      'after init should not expose legacy alembic_task'
    );
    const legacyRecordDecision = await probeLegacyRecordDecision(client, stderr);
    expectIssue(
      issues,
      legacyRecordDecision.blocked === true,
      'legacy alembic_task record_decision should block without local fake decision'
    );
    expectIssue(
      issues,
      legacyRecordDecision.localDecisionRef === false,
      'legacy alembic_task record_decision should not return a local decision id'
    );

    return {
      ok: issues.length === 0,
      targetRoot,
      marker: summarizeMarker(marker),
      beforeInit,
      calls,
      afterInit: {
        names: afterInit.names,
        legacyTaskCompatibility: {
          hiddenDirectCallOnly: !afterInit.names.includes('alembic_task'),
          recordDecisionBlocked: legacyRecordDecision.blocked,
          recordDecisionErrorCode: legacyRecordDecision.errorCode,
          recordDecisionWritesLocalDecision:
            legacyRecordDecision.writesLocalDecision ?? legacyRecordDecision.localDecisionRef,
          visible: false,
        },
      },
      legacyRecordDecision,
      issues,
    };
  } finally {
    await closeClient(client, stderr, targetRoot);
  }
}

async function probeLegacyRecordDecision(client, stderr) {
  const call = await callJsonTool(
    client,
    'alembic_task',
    {
      description: 'Probe hidden legacy record_decision cleanup.',
      operation: 'record_decision',
      rationale: 'Durable Decision Register must be the only confirmed-decision writer.',
      tags: ['afapi-08'],
      title: 'Legacy decision direct-call probe',
    },
    stderr
  );
  const legacyCompatibility = objectPath(call.payload, ['data', 'legacyCompatibility']);
  const decision = objectPath(call.payload, ['data', 'decision']);
  return {
    blocked:
      call.payload?.success === false &&
      call.payload?.errorCode === 'legacy-record-decision-disabled' &&
      legacyCompatibility?.status === 'blocked' &&
      legacyCompatibility?.replacementTool === 'alembic_decision_record',
    errorCode: call.payload?.errorCode ?? null,
    isError: call.isError,
    localDecisionRef: typeof decision?.id === 'string',
    success: call.payload?.success === true,
    writesLocalDecision:
      typeof legacyCompatibility?.writesLocalDecision === 'boolean'
        ? legacyCompatibility.writesLocalDecision
        : null,
  };
}

async function runPublicToolCalls(client, stderr) {
  const intent = await callJsonTool(
    client,
    'alembic_intent',
    {
      hostDeclaredIntent: {
        action: 'implement',
        confidence: 0.92,
        language: 'typescript',
        query: 'Evaluate AFAPI Stage 6 public tools',
        sourceRefs: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
      },
      inputSource: 'host-declared-intent',
      outputBudget: { maxChars: 220, mode: 'compact' },
      projectRoot,
      sourceRefs: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
    },
    stderr
  );
  const intentRef = stringPath(intent.payload, ['data', 'intentRef']);

  const prime = await callJsonTool(
    client,
    'alembic_prime',
    {
      inputSource: 'host-declared-intent',
      intentRef,
      outputBudget: { maxChars: 220, mode: 'compact' },
      projectRoot,
      sourceRefs: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
    },
    stderr
  );
  const primeRef = stringPath(prime.payload, ['data', 'result', 'refs', 'primeRef', 'id'], null);

  const workStartArgs = {
    inputSource: 'host-declared-intent',
    intentRef,
    outputBudget: { maxChars: 180, mode: 'compact' },
    projectRoot,
    title: 'Evaluate public tools closure',
    workScope: {
      files: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
      goal: 'Close Stage 6 installed-cache readback evidence.',
    },
  };
  if (primeRef) {
    workStartArgs.primeRef = primeRef;
  }
  const workStart = await callJsonTool(client, 'alembic_work_start', workStartArgs, stderr);
  const workRef = stringPath(workStart.payload, ['data', 'workRef']);

  const workFinish = await callJsonTool(
    client,
    'alembic_work_finish',
    {
      changedFiles: ['test/unit/AgentPublicToolsEvaluation.test.ts'],
      evidenceRefs: ['scratch/afapi-stage6-agent-public-tools-readback.json'],
      inputSource: 'host-declared-intent',
      outputBudget: { maxChars: 180, mode: 'compact' },
      projectRoot,
      summary: 'Stage 6 installed-cache readback evidence is ready.',
      workRef,
    },
    stderr
  );

  const codeGuard = await callJsonTool(
    client,
    'alembic_code_guard',
    {
      inputSource: 'host-declared-intent',
      outputBudget: { maxChars: 160, mode: 'compact' },
      projectRoot,
    },
    stderr
  );

  const codeGuardScopedWorkRef = await callJsonTool(
    client,
    'alembic_code_guard',
    {
      inputSource: 'host-declared-intent',
      outputBudget: { maxChars: 160, mode: 'compact' },
      projectRoot,
      workRef,
    },
    stderr
  );

  const decisionRecord = await callJsonTool(
    client,
    'alembic_decision_record',
    {
      description: 'Stage 6 installed-cache readback asks for durable decision route.',
      evidenceRefs: ['scratch/afapi-stage6-agent-public-tools-readback.json'],
      inputSource: 'host-declared-intent',
      intentRef,
      outputBudget: { maxChars: 180, mode: 'compact' },
      projectRoot,
      title: 'Close public tools evaluation',
      workRef,
    },
    stderr
  );

  return {
    alembic_intent: summarizeCall(intent),
    alembic_prime: summarizeCall(prime),
    alembic_work_start: summarizeCall(workStart),
    alembic_work_finish: summarizeCall(workFinish),
    alembic_code_guard: summarizeCall(codeGuard),
    alembic_code_guard_scoped_work_ref: summarizeCall(codeGuardScopedWorkRef),
    alembic_decision_record: summarizeCall(decisionRecord),
  };
}

function evaluateCalls(issues, calls) {
  expectIssue(issues, calls.alembic_intent.status === 'ready', 'intent should be ready');
  expectIssue(
    issues,
    ['ready', 'degraded', 'skipped'].includes(calls.alembic_prime.status),
    'prime should return a structured ready/degraded/skipped envelope'
  );
  expectIssue(issues, calls.alembic_work_start.status === 'ready', 'work_start should be ready');
  expectIssue(issues, calls.alembic_work_finish.status === 'ready', 'work_finish should be ready');
  expectIssue(
    issues,
    calls.alembic_code_guard.status === 'blocked' &&
      calls.alembic_code_guard.reasonCode === 'missing-guard-scope',
    'code_guard should block no-scope readback with missing-guard-scope'
  );
  expectIssue(
    issues,
    calls.alembic_code_guard_scoped_work_ref.status === 'ready',
    'code_guard scoped workRef readback should be ready'
  );
  expectIssue(
    issues,
    calls.alembic_decision_record.status === 'blocked' &&
      ['decision-register-unavailable', 'decision-register-capability-mismatch'].includes(
        calls.alembic_decision_record.reasonCode
      ),
    'decision_record should block without a durable resident route'
  );
  for (const [toolName, call] of Object.entries(calls)) {
    expectIssue(issues, call.hasResultEnvelope, `${toolName} did not return data.result`);
    expectIssue(
      issues,
      call.usesLegacyTaskHandler === false,
      `${toolName} should not use legacy task handler`
    );
    expectIssue(issues, call.budgetOk === true, `${toolName} output budget was invalid`);
  }
}

function summarizeCall(call) {
  const result = objectPath(call.payload, ['data', 'result']);
  const budget = objectPath(result, ['summary', 'outputBudget']);
  return {
    isError: call.isError,
    success: call.payload?.success === true,
    status: typeof result?.status === 'string' ? result.status : null,
    reasonCode:
      result?.reason && typeof result.reason === 'object' ? (result.reason.code ?? null) : null,
    actionKind: typeof result?.actionKind === 'string' ? result.actionKind : null,
    toolName: typeof result?.toolName === 'string' ? result.toolName : null,
    hasResultEnvelope: Boolean(result),
    budget: budget || null,
    budgetOk: isBudgetOk(budget),
    usesLegacyTaskHandler: result?.legacyCompatibility?.usesLegacyTaskHandler ?? null,
    refs: {
      detailRefs: Array.isArray(result?.refs?.detailRefs) ? result.refs.detailRefs.length : 0,
      intentRef: Boolean(result?.refs?.intentRef),
      primeRef: Boolean(result?.refs?.primeRef),
      workRef: Boolean(result?.refs?.workRef),
      finishRef: Boolean(result?.refs?.finishRef),
      guardResultRef: Boolean(result?.refs?.guardResultRef),
      decisionRef: Boolean(result?.refs?.decisionRef),
    },
  };
}

async function listTools(client, stderr) {
  return await withTimeout(
    client.listTools(undefined, { timeout: options.mcpTimeoutMs }),
    options.mcpTimeoutMs + 2000,
    () => `MCP tools/list timed out\n${stderr.join('')}`
  );
}

async function callJsonTool(client, name, args, stderr) {
  const result = await withTimeout(
    client.callTool({ name, arguments: args }, undefined, { timeout: options.mcpTimeoutMs }),
    options.mcpTimeoutMs + 2000,
    () => `MCP ${name} timed out\n${stderr.join('')}`
  );
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new Error(`MCP ${name} returned no JSON text\n${JSON.stringify(result)}`);
  }
  return {
    isError: result.isError === true,
    payload: JSON.parse(text),
  };
}

function summarizeToolSurface(tools) {
  const descriptions = Object.fromEntries(
    tools.map((tool) => [tool.name, typeof tool.description === 'string' ? tool.description : ''])
  );
  return {
    names: tools.map((tool) => tool.name).sort(),
    descriptions,
  };
}

function readMcpServerConfig(targetRoot) {
  const mcp = readJson(join(targetRoot, '.mcp.json'));
  const server = mcp.mcpServers?.alembic;
  if (!server?.command || !Array.isArray(server.args)) {
    throw new Error(`Invalid Alembic MCP config at ${targetRoot}`);
  }
  return {
    command: server.command,
    args: server.args,
    env: server.env || {},
  };
}

function resolveInstalledTargets() {
  const plugin = readJson(join(root, 'plugins', 'alembic-codex', '.codex-plugin', 'plugin.json'));
  const cacheRoot = resolve(options.codexHome || join(process.env.HOME || '', '.codex'));
  const candidates = [
    join(cacheRoot, 'plugins', 'cache', 'alembic-codex', plugin.name, plugin.version),
    join(cacheRoot, 'plugins', 'cache', 'gxfn', plugin.name, plugin.version),
  ];
  const targets = candidates.filter((target) => existsSync(join(target, '.mcp.json')));
  if (targets.length === 0) {
    throw new Error(`No installed Alembic Codex plugin cache targets found under ${cacheRoot}`);
  }
  return targets;
}

function summarizeMarker(marker) {
  if (!marker) {
    return null;
  }
  return {
    refreshedAt: marker.refreshedAt ?? null,
    gitHead: marker.gitHead ?? null,
    mode: marker.mode ?? null,
    hashes: marker.hashes ?? null,
  };
}

function isBudgetOk(budget) {
  return Boolean(
    budget &&
      typeof budget.maxChars === 'number' &&
      typeof budget.usedChars === 'number' &&
      budget.maxChars > 0 &&
      budget.usedChars >= 0 &&
      budget.usedChars <= budget.maxChars &&
      typeof budget.truncated === 'boolean'
  );
}

function objectPath(value, path) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = current[key];
  }
  return current && typeof current === 'object' ? current : null;
}

function stringPath(value, path, fallback = undefined) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      if (fallback !== undefined) {
        return fallback;
      }
      throw new Error(`Missing string path ${path.join('.')}`);
    }
    current = current[key];
  }
  if (typeof current !== 'string') {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Expected string path ${path.join('.')}`);
  }
  return current;
}

function expectIssue(issues, condition, message) {
  if (!condition) {
    issues.push(message);
  }
}

async function closeClient(client, stderr, targetRoot) {
  try {
    await client.close();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const connectionClosed =
      error.message.includes('Connection closed') || error.message.includes('-32000');
    if (!connectionClosed) {
      throw new Error(`MCP close failed for ${targetRoot}: ${error.message}\n${stderr.join('')}`);
    }
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message())), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === 'string' && value.length > 0)
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readOptionalJson(path) {
  return existsSync(path) ? readJson(path) : null;
}

function writeReport() {
  mkdirSync(dirname(options.reportPath), { recursive: true });
  writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = {
    codexHome: '',
    keepTmp: false,
    mcpTimeoutMs: 30000,
    projectRoot: '',
    reportPath: join(root, 'scratch', 'afapi-stage6-agent-public-tools-readback.json'),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--codex-home') {
      parsed.codexHome = args[index + 1] || '';
      index += 1;
    } else if (arg === '--keep-tmp') {
      parsed.keepTmp = true;
    } else if (arg === '--mcp-timeout-ms') {
      parsed.mcpTimeoutMs = Number(args[index + 1] || parsed.mcpTimeoutMs);
      index += 1;
    } else if (arg === '--project-root') {
      parsed.projectRoot = resolve(args[index + 1] || '');
      index += 1;
    } else if (arg === '--report-path') {
      parsed.reportPath = resolve(args[index + 1] || parsed.reportPath);
      index += 1;
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/probe-agent-public-tools-evaluation.mjs [options]

Options:
  --codex-home <path>       Override Codex home cache root.
  --keep-tmp                Keep temporary project and ALEMBIC_HOME data.
  --mcp-timeout-ms <ms>     MCP connect/call timeout. Default: 30000.
  --project-root <path>     Probe project root. Default: fresh temp project.
  --report-path <path>      JSON report path.
`);
}
