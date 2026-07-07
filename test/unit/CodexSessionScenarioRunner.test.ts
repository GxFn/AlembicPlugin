import { describe, expect, test } from 'vitest';
import {
  loadCodexSessionScenarios,
  runCodexSessionScenario,
} from '../support/codex-session/index.js';

const scenarios = loadCodexSessionScenarios({
  filter: process.env.CODEX_SESSION_SCENARIO_FILTER,
});
const scenarioTimeoutMs = Number(process.env.CODEX_SESSION_TEST_TIMEOUT_MS || 20_000);
const coldStartPlanGateScenarioIds = new Set([
  'bootstrap-missing-ai-uses-host-agent',
  'init-then-codex-host-bootstrap',
]);
const coldStartPlanGateScenarios = loadCodexSessionScenarios().filter((scenario) =>
  coldStartPlanGateScenarioIds.has(scenario.id)
);

describe('Codex session scenario runner', () => {
  test('loads at least one scenario', () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  test('cold-start Plan-gate scenarios derive dimensions from the stateless draft and confirm a planSelection', () => {
    expect(coldStartPlanGateScenarios.map((scenario) => scenario.id).sort()).toEqual(
      [...coldStartPlanGateScenarioIds].sort()
    );

    const serializedScenarios = JSON.stringify(coldStartPlanGateScenarios);
    // Stateless plan contract (Core be212051): scenarios read the cold-start
    // dimension from the draft's candidateDimensions projection, then hand the
    // confirmed planSelection to bootstrap. No stateful plan identity, no
    // multi-stage residue, no removed draft-boundary shapes.
    expect(serializedScenarios).toContain('data.candidateDimensions.0.id');
    expect(serializedScenarios).toContain('data.planSelection');
    expect(serializedScenarios).not.toMatch(
      /confirmedPlanBoundary|projectContextSignature|basePlanId|baseVersion|perStage|sourceReports\.planningAids\.selection|activeDimensionIds|skippedDimensionIds|lowConfidenceDimensions/
    );
  });

  for (const scenario of scenarios) {
    test(
      scenario.id,
      async () => {
        const result = await runCodexSessionScenario(scenario);
        expect(
          result.errors,
          `summary: ${result.summaryPath}\ntranscript: ${result.transcriptPath}`
        ).toEqual([]);
      },
      scenarioTimeoutMs
    );
  }
});
