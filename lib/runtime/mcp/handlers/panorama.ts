/**
 * MCP Handler — alembic_panorama
 *
 * Project panorama query tool with 8 operations:
 *   overview — project skeleton + layers + module roles
 *   module   — single module detail + neighbors + recipes + file groups
 *   gaps     — knowledge gaps (code without Recipes)
 *   health   — panorama health (coverage + coupling + cycles)
 *   governance_cycle       — full metabolism cycle (contradiction + redundancy + decay)
 *   decay_report           — decay assessment report
 *   staging_check          — staging entry check + auto-publish
 *   enhancement_suggestions — usage-data-based enhancement suggestions
 *
 * All read-only except governance_cycle and staging_check (which perform state transitions).
 */

import { envelope } from '../../../runtime/mcp/envelope.js';
import type { McpContext } from '../../../runtime/mcp/handlers/types.js';

interface PanoramaArgs {
  operation?: string;
  module?: string;
}

const RETIRED_PROJECT_INFORMATION_OPS = new Set(['overview', 'module', 'gaps', 'health']);

/**
 * alembic_panorama — unified panorama query
 */
export async function panoramaHandler(ctx: McpContext, args: PanoramaArgs) {
  const op = args.operation || 'overview';

  if (RETIRED_PROJECT_INFORMATION_OPS.has(op)) {
    return retiredProjectInformationResponse(op, args.module);
  }

  // ── Governance operations remain independent of the retired project-information provider. ──
  return handleGovernanceOps(ctx, op);
}

function retiredProjectInformationResponse(operation: string, moduleName?: string) {
  return envelope({
    success: false,
    data: {
      module: moduleName ?? null,
      operation,
      replacementTools: ['alembic_project_matrix', 'alembic_graph'],
      retired: true,
    },
    message:
      'alembic_panorama project-information operations are retired; use alembic_project_matrix for overview or alembic_graph for ProjectContext-backed relation details.',
    meta: {
      operation,
      retired: true,
      tool: 'alembic_panorama',
    },
  });
}

/* ────────────────────── Governance Handlers ────────────────────── */

async function handleGovernanceOps(ctx: McpContext, op: string) {
  switch (op) {
    case 'governance_cycle': {
      return envelope({
        success: false,
        message: 'KnowledgeMetabolism has been removed. Use rescan for governance.',
        meta: { tool: 'alembic_panorama', operation: 'governance_cycle' },
      });
    }

    case 'decay_report': {
      const decayDetector = ctx.container.get('decayDetector') as
        | { scanAll(): unknown }
        | undefined;

      if (!decayDetector) {
        return envelope({
          success: false,
          message: 'Decay detector not initialized (decayDetector not registered)',
          meta: { tool: 'alembic_panorama' },
        });
      }

      const results = await decayDetector.scanAll();
      return envelope({
        success: true,
        data: { results },
        meta: { tool: 'alembic_panorama', operation: 'decay_report' },
      });
    }

    case 'staging_check': {
      const stagingManager = ctx.container.get('stagingManager') as
        | { checkAndPromote(): unknown; listStaging(): unknown }
        | undefined;

      if (!stagingManager) {
        return envelope({
          success: false,
          message: 'Staging manager not initialized (stagingManager not registered)',
          meta: { tool: 'alembic_panorama' },
        });
      }

      const checkResult = await stagingManager.checkAndPromote();
      const currentStaging = await stagingManager.listStaging();
      return envelope({
        success: true,
        data: { checkResult, currentStaging },
        meta: { tool: 'alembic_panorama', operation: 'staging_check' },
      });
    }

    case 'enhancement_suggestions': {
      const suggester = ctx.container.get('enhancementSuggester') as
        | { analyzeAll(): unknown }
        | undefined;

      if (!suggester) {
        return envelope({
          success: false,
          message: 'Enhancement suggester not initialized (enhancementSuggester not registered)',
          meta: { tool: 'alembic_panorama' },
        });
      }

      const suggestions = await suggester.analyzeAll();
      return envelope({
        success: true,
        data: { suggestions },
        meta: { tool: 'alembic_panorama', operation: 'enhancement_suggestions' },
      });
    }

    default:
      throw new Error(
        `Unknown panorama operation: ${op}. Expected: overview, module, gaps, health, governance_cycle, decay_report, staging_check, enhancement_suggestions`
      );
  }
}
