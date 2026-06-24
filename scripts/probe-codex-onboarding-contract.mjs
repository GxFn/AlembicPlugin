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

const [{ HostMcpServer }, { resolveDaemonPaths }] = await Promise.all([
  import('../dist/lib/runtime/mcp/HostMcpServer.js'),
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

const server = new HostMcpServer({ projectRoot, supervisor });
const planSelection = await confirmPlanSelection(server, projectRoot);
const bootstrap = await server.handleToolCall('alembic_bootstrap', { planSelection });
const status = await server.handleToolCall('alembic_status', {});

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
    currentDimensionGuidance: {
      currentTier: data?.currentDimensionGuidance?.currentTier,
      dimensionIds: data?.currentDimensionGuidance?.dimensionIds,
      dimensions: data?.currentDimensionGuidance?.dimensions?.map((dimension) => ({
        dimensionId: dimension?.dimensionId,
        hasAnalysisGuide: Boolean(dimension?.analysisGuide),
        hasSubmissionSpec: Boolean(dimension?.submissionSpec),
      })),
    },
    gates: Object.keys(data?.gates || {}),
    retiredFieldsAbsent: {
      currentDomainSop: data?.currentDomainSop === undefined,
      domainQueue: data?.domainQueue === undefined,
      sopPack: data?.sopPack === undefined,
    },
    repairState: data?.repairState,
    hostAgentContractFields: Object.keys(data?.hostAgentContract || {}),
    hostAgentContractRequiredReadback: {
      hasKnowledgeResetContract: Boolean(data?.hostAgentContract?.knowledgeResetContract?.scopes),
      hasRecipeAuthoringRubric: Boolean(data?.hostAgentContract?.recipeAuthoringRubric),
      hasRecipeCreationSop: Boolean(data?.hostAgentContract?.recipeCreationSop),
      hasScopeBrief: Boolean(data?.hostAgentContract?.scopeBrief),
      hasStopConditions: Boolean(data?.hostAgentContract?.stopConditions),
      hasSubmitKnowledgeContract: Boolean(data?.hostAgentContract?.submitKnowledgeContract),
      hasToolCapabilityMatrix: Boolean(data?.hostAgentContract?.toolCapabilityMatrix),
    },
    toolCapabilities: {
      canonicalSourceGraph: data?.toolCapabilities?.canonicalSourceGraph?.map((tool) => tool.name),
      removedOrBlocked: data?.toolCapabilities?.removedOrBlocked?.map((tool) => tool.name),
    },
    agentReadinessWalkthrough: {
      firstTool: data?.initialToolBriefing?.defaultOrder?.[0],
      currentDomainEvidenceTool:
        data?.currentDimensionNextActions?.[1]?.tool ||
        data?.currentDimensionGuidance?.nextActions?.[1]?.tool,
      blockedConclusions: data?.repairState?.blockedConclusions?.slice(0, 4),
      stopConditions: data?.hostAgentContract?.stopConditions?.slice(0, 4),
      hiddenProjectKnowledgeRequired: false,
    },
  };
}

async function confirmPlanSelection(server, projectRoot) {
  const draft = await server.handleToolCall('alembic_plan', {
    operation: 'draft',
    projectRoot,
    hints: { maxBudget: 8 },
  });
  if (draft?.success !== true) {
    throw new Error(`alembic_plan draft failed: ${JSON.stringify(draft)}`);
  }
  const dimensionIds = readArray(draft?.data?.candidateDimensions)
    .map((dimension) => readRecord(dimension).id)
    .filter((dimensionId) => typeof dimensionId === 'string' && dimensionId.length > 0);
  if (dimensionIds.length === 0) {
    throw new Error('alembic_plan draft returned no candidate dimensions');
  }
  const confirmed = await server.handleToolCall('alembic_plan', {
    operation: 'confirm',
    projectRoot,
    generationStage: 'coldStart',
    projectProfile: {
      projectType: 'node-package',
      primaryLanguage: 'typescript',
      secondaryLanguages: [],
      frameworks: ['node'],
      moduleCount: 1,
      fileCount: 2,
    },
    selectedDimensions: dimensionIds.map((dimensionId, index) => ({
      dimensionId,
      priority: index + 1,
      rationale: 'Onboarding probe confirms stateless planSelection.',
      targetRecipes: 1,
    })),
    scale: {
      totalRecipeBudget: dimensionIds.length,
      maxFiles: 8,
      contentMaxLines: 24,
      depthLevels: ['project'],
    },
    moduleBindings: [
      {
        modulePath: 'src',
        dimensions: dimensionIds,
        targetRecipes: 1,
        priority: 1,
      },
    ],
    plannedNextActions: [{ tool: 'alembic_bootstrap', reason: 'Run Plan-gated bootstrap.' }],
    evidenceRefs: [
      {
        kind: 'project-context',
        ref: String(draft?.data?.projectContextSignature || 'probe-signature'),
        detail: 'draft fact package signature',
      },
    ],
    rationale: 'Probe confirms a complete Plan payload before bootstrap.',
  });
  if (confirmed?.success !== true) {
    throw new Error(`alembic_plan confirm failed: ${JSON.stringify(confirmed)}`);
  }
  return readRecord(confirmed?.data?.planSelection);
}

function readRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readArray(value) {
  return Array.isArray(value) ? value : [];
}
