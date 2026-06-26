/**
 * MCP Handler — alembic_evolve (批量 Recipe 进化决策)
 *
 * 所有决策统一通过 EvolutionGateway 提交：
 *   - propose_evolution → gateway.submit({ action: 'update' })
 *   - confirm_deprecation → gateway.submit({ action: 'deprecate' })
 *   - skip → gateway.submit({ action: 'valid' }) 或直接 skip
 *
 * @module handlers/host-agent/evolve
 */

import type { EvolutionGateway } from '@alembic/core/evolution';
import { HOST_AGENT_SOURCE } from '@alembic/core/shared';
import type { StructuredPatch } from '@alembic/core/types';
import { envelope } from '#codex/mcp/envelope.js';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import type { EvolveInput } from '#shared/schemas/mcp-tools.js';
import {
  mergeFreshnessOutputs,
  type RecipeFreshnessPublicOutput,
  type RecipeFreshnessPublicRecipe,
  refreshRecipeFreshnessByIds,
  skippedRecipe,
} from '../../../../service/knowledge/RecipeFreshnessRuntime.js';

/** MCP handler context */
interface McpContext {
  container: ServiceContainer;
  logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
  startedAt?: number;
  [key: string]: unknown;
}

// ── 返回类型 ─────────────────────────────────────────────

interface EvolveResult {
  processed: number;
  proposed: number;
  deprecated: number;
  skipped: number;
  refreshed: number;
  quotaChange: { freed: number; occupied: number };
  errors: Array<{ recipeId: string; error: string }>;
  freshness?: RecipeFreshnessPublicOutput;
  retrievalMayBeStale?: boolean;
}

type EvolveDecision = EvolveInput['decisions'][number];

interface EvolveFreshnessTracker {
  recipeIds: Set<string>;
  skipped: RecipeFreshnessPublicRecipe[];
}

// ── 主入口 ─────────────────────────────────────────────────

export async function evolveForHostAgent(ctx: McpContext, args: EvolveInput) {
  const t0 = Date.now();
  const { decisions } = args;

  if (!decisions || decisions.length === 0) {
    return envelope({
      success: true,
      data: {
        processed: 0,
        proposed: 0,
        deprecated: 0,
        skipped: 0,
        refreshed: 0,
        quotaChange: { freed: 0, occupied: 0 },
        errors: [],
      },
      message: '⚠️ 没有提交任何 evolve 决策',
      meta: { tool: 'alembic_evolve', responseTimeMs: Date.now() - t0 },
    });
  }

  const result = createEvolveResult();
  const freshness = createFreshnessTracker();

  const gateway = ctx.container.get('evolutionGateway') as EvolutionGateway | null;
  if (!gateway) {
    return envelope({
      success: false,
      data: result,
      message: '❌ EvolutionGateway not available',
      meta: { tool: 'alembic_evolve', responseTimeMs: Date.now() - t0 },
    });
  }

  for (const decision of decisions) {
    await processEvolveDecision({ ctx, decision, freshness, gateway, result });
  }

  await attachFreshness(ctx, result, freshness);
  const summary = buildEvolveSummary(result);

  return envelope({
    success: true,
    data: result,
    message:
      `✅ 处理了 ${result.processed} 个 Recipe: ${summary}` +
      (result.errors.length > 0 ? ` (${result.errors.length} 个错误)` : ''),
    meta: { tool: 'alembic_evolve', responseTimeMs: Date.now() - t0 },
  });
}

function createEvolveResult(): EvolveResult {
  return {
    processed: 0,
    proposed: 0,
    deprecated: 0,
    skipped: 0,
    refreshed: 0,
    quotaChange: { freed: 0, occupied: 0 },
    errors: [],
  };
}

function createFreshnessTracker(): EvolveFreshnessTracker {
  return {
    recipeIds: new Set<string>(),
    skipped: [],
  };
}

async function processEvolveDecision(input: {
  ctx: McpContext;
  decision: EvolveDecision;
  freshness: EvolveFreshnessTracker;
  gateway: EvolutionGateway;
  result: EvolveResult;
}): Promise<void> {
  const { ctx, decision, freshness, gateway, result } = input;
  try {
    switch (decision.action) {
      case 'propose_evolution':
        await handleProposeEvolution(ctx, gateway, decision, result, freshness);
        break;
      case 'confirm_deprecation':
        await handleConfirmDeprecation(ctx, gateway, decision, result, freshness);
        break;
      case 'skip':
        await handleSkipDecision(ctx, gateway, decision, result, freshness);
        break;
      default:
        recordEvolveError(
          result,
          decision,
          `Unknown action: ${(decision as { action: string }).action}`
        );
    }
  } catch (err: unknown) {
    recordEvolveError(result, decision, err instanceof Error ? err.message : String(err));
  } finally {
    result.processed++;
  }
}

async function handleProposeEvolution(
  ctx: McpContext,
  gateway: EvolutionGateway,
  decision: EvolveDecision,
  result: EvolveResult,
  freshness: EvolveFreshnessTracker
): Promise<void> {
  if (decision.action !== 'propose_evolution') {
    return;
  }
  if (!decision.evidence) {
    recordEvolveError(result, decision, 'evidence is required for propose_evolution');
    return;
  }
  const structuredSuggestedChanges = normalizeSuggestedChangesPatch(decision.evidence);

  const gatewayResult = await gateway.submit({
    recipeId: decision.recipeId,
    action: 'update',
    source: HOST_AGENT_SOURCE,
    confidence: 0.8,
    description: decision.evidence.suggestedChanges,
    evidence: [
      {
        sourceStatus: 'modified',
        currentCode: decision.evidence.codeSnippet,
        filePath: decision.evidence.filePath,
        suggestedChanges: structuredSuggestedChanges,
        verifiedBy: HOST_AGENT_SOURCE,
        verifiedAt: Date.now(),
      },
    ],
  });

  if (
    gatewayResult.outcome === 'proposal-created' ||
    gatewayResult.outcome === 'proposal-upgraded'
  ) {
    result.proposed++;
    freshness.skipped.push(
      skippedRecipe(decision.recipeId, `proposal-only:${gatewayResult.outcome}`)
    );
    ctx.logger.info(
      `[Evolve] propose_evolution: ${decision.recipeId} → ${gatewayResult.outcome} ${gatewayResult.proposalId}`
    );
    return;
  }

  recordEvolveError(
    result,
    decision,
    gatewayResult.error ?? `Unexpected outcome: ${gatewayResult.outcome}`
  );
}

function normalizeSuggestedChangesPatch(evidence: NonNullable<EvolveDecision['evidence']>): string {
  const raw = evidence.suggestedChanges.trim();
  if (isStructuredPatchJson(raw)) {
    return raw;
  }
  const patch: StructuredPatch = {
    patchVersion: 1,
    changes: [
      {
        field: 'content.markdown',
        action: 'append',
        newValue: buildHostAgentEvolutionEvidenceBlock(evidence),
      },
    ],
    reasoning: raw,
  };
  return JSON.stringify(patch);
}

function isStructuredPatchJson(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed.patchVersion === 1 && Array.isArray(parsed.changes);
  } catch {
    return false;
  }
}

function buildHostAgentEvolutionEvidenceBlock(
  evidence: NonNullable<EvolveDecision['evidence']>
): string {
  const codeSnippet = evidence.codeSnippet.trim();
  return [
    '### Host-agent evolution evidence',
    '',
    `- Source: ${evidence.filePath}`,
    `- Type: ${evidence.type}`,
    `- Suggested change: ${evidence.suggestedChanges.trim()}`,
    '',
    'Current code excerpt:',
    '```',
    codeSnippet.length > 0 ? codeSnippet.slice(0, 2000) : '(empty or unreadable source excerpt)',
    '```',
  ].join('\n');
}

async function handleConfirmDeprecation(
  ctx: McpContext,
  gateway: EvolutionGateway,
  decision: EvolveDecision,
  result: EvolveResult,
  freshness: EvolveFreshnessTracker
): Promise<void> {
  if (decision.action !== 'confirm_deprecation') {
    return;
  }
  const gatewayResult = await gateway.submit({
    recipeId: decision.recipeId,
    action: 'deprecate',
    source: HOST_AGENT_SOURCE,
    confidence: 0.9,
    reason: decision.reason || 'Host agent confirmed deprecation',
  });

  if (gatewayResult.outcome === 'immediately-executed') {
    result.deprecated++;
    result.quotaChange.freed++;
    freshness.recipeIds.add(decision.recipeId);
    ctx.logger.info(`[Evolve] confirm_deprecation: ${decision.recipeId}`);
    return;
  }

  if (gatewayResult.outcome === 'proposal-created') {
    result.deprecated++;
    result.quotaChange.freed++;
    freshness.skipped.push(skippedRecipe(decision.recipeId, 'proposal-only:proposal-created'));
    ctx.logger.info(`[Evolve] confirm_deprecation: ${decision.recipeId}`);
    return;
  }

  recordEvolveError(
    result,
    decision,
    gatewayResult.error ?? `Unexpected outcome: ${gatewayResult.outcome}`
  );
}

async function handleSkipDecision(
  ctx: McpContext,
  gateway: EvolutionGateway,
  decision: EvolveDecision,
  result: EvolveResult,
  freshness: EvolveFreshnessTracker
): Promise<void> {
  if (decision.action !== 'skip') {
    return;
  }
  if (decision.skipReason === 'still_valid') {
    const gatewayResult = await gateway.submit({
      recipeId: decision.recipeId,
      action: 'valid',
      source: HOST_AGENT_SOURCE,
      confidence: 0.5,
      reason: decision.skipReason,
    });

    if (gatewayResult.outcome === 'verified') {
      result.refreshed++;
      freshness.recipeIds.add(decision.recipeId);
    }
  } else {
    freshness.skipped.push(skippedRecipe(decision.recipeId, 'skip-insufficient-info'));
  }

  result.skipped++;
  ctx.logger.info(`[Evolve] skip: ${decision.recipeId} (${decision.skipReason || 'no reason'})`);
}

async function attachFreshness(
  ctx: McpContext,
  result: EvolveResult,
  tracker: EvolveFreshnessTracker
): Promise<void> {
  const refreshed = await refreshRecipeFreshnessByIds(ctx.container, [...tracker.recipeIds]);
  const freshness = mergeFreshnessOutputs([refreshed], tracker.skipped);
  if (!freshness) {
    return;
  }
  result.freshness = freshness;
  result.retrievalMayBeStale = freshness.retrievalMayBeStale;
}

function buildEvolveSummary(result: EvolveResult): string {
  const parts: string[] = [];
  if (result.proposed > 0) {
    parts.push(`${result.proposed} 个进化提案`);
  }
  if (result.deprecated > 0) {
    parts.push(`${result.deprecated} 个废弃`);
  }
  if (result.refreshed > 0) {
    parts.push(`${result.refreshed} 个仍然有效`);
  }
  if (result.skipped - result.refreshed > 0) {
    parts.push(`${result.skipped - result.refreshed} 个跳过`);
  }
  return parts.length > 0 ? parts.join(', ') : '无变更';
}

function recordEvolveError(result: EvolveResult, decision: EvolveDecision, error: string): void {
  result.errors.push({
    recipeId: decision.recipeId,
    error,
  });
}
