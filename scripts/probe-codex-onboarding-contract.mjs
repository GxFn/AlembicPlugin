import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-onboarding-home-'));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-onboarding-project-'));
process.env.ALEMBIC_HOME = tempHome;
process.env.ALEMBIC_PROJECT_DIR = projectRoot;
process.env.CODEX_WORKSPACE_ROOT = projectRoot;
process.env.PWD = projectRoot;

fs.mkdirSync(path.join(projectRoot, '.asd'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, '.asd', 'config.json'), '{}\n');
fs.writeFileSync(path.join(projectRoot, '.asd', 'alembic.db'), '');
fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
fs.mkdirSync(path.join(projectRoot, 'Alembic', 'skills'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export const onboardingProbe = 42;\n');

const [{ CodexMcpServer }, { resolveDaemonPaths }] = await Promise.all([
  import('../dist/lib/codex/mcp/CodexMcpServer.js'),
  import('@alembic/core/daemon'),
]);

const supervisor = {
  async status(root) {
    const paths = resolveDaemonPaths(root);
    return {
      status: 'stopped',
      ready: false,
      projectRoot: paths.projectRoot,
      dataRoot: paths.dataRoot,
      projectId: paths.projectId,
      statePath: paths.statePath,
      pidPath: paths.pidPath,
      lockDir: paths.lockDir,
      logPath: paths.logPath,
      state: null,
      pidAlive: false,
      health: null,
    };
  },
};

const server = new CodexMcpServer({ projectRoot, supervisor });
const bootstrap = await server.handleToolCall('alembic_bootstrap', {});
const status = await server.handleToolCall('alembic_codex_status', {});

console.log(
  JSON.stringify(
    {
      ok: bootstrap.success === true && status.success === true,
      projectRoot,
      bootstrap: summarizeContract(bootstrap.data),
      status: summarizeContract(status.data?.onboarding),
    },
    null,
    2
  )
);

function summarizeContract(data) {
  return {
    bootstrapState: data?.bootstrapState,
    currentDomainSop: {
      domainId: data?.currentDomainSop?.domainId,
      languageProfile: data?.currentDomainSop?.languageProfile,
      recipeGuidanceFloor: data?.currentDomainSop?.recipeGuidanceFloor,
      toolSequence: data?.currentDomainSop?.toolSequence,
    },
    domainQueueFirst: data?.domainQueue?.[0],
    gates: Object.keys(data?.gates || {}),
    repairState: data?.repairState,
    sopPackFields: Object.keys(data?.sopPack || {}),
    sopPackRequiredReadback: {
      hasKnowledgeResetContract: Boolean(data?.sopPack?.knowledgeResetContract?.scopes),
      hasRecipeAuthoringRubric: Boolean(data?.sopPack?.recipeAuthoringRubric),
      hasResumePrompt: Boolean(data?.sopPack?.resumePrompt),
      hasScopeBrief: Boolean(data?.sopPack?.scopeBrief),
      hasStopConditions: Boolean(data?.sopPack?.stopConditions),
      hasToolCapabilityMatrix: Boolean(data?.sopPack?.toolCapabilityMatrix),
    },
    toolCapabilities: {
      canonicalSourceGraph: data?.toolCapabilities?.canonicalSourceGraph?.map((tool) => tool.name),
      removedOrBlocked: data?.toolCapabilities?.removedOrBlocked?.map((tool) => tool.name),
    },
    agentReadinessWalkthrough: {
      firstTool: data?.initialToolBriefing?.defaultOrder?.[0],
      currentDomainEvidenceTool:
        data?.currentDomainNextActions?.[1]?.tool || data?.currentDomainSop?.toolSequence?.[1],
      blockedConclusions: data?.repairState?.blockedConclusions?.slice(0, 4),
      stopConditions: data?.sopPack?.stopConditions?.slice(0, 4),
      hiddenProjectKnowledgeRequired: false,
    },
  };
}
