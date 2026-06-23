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

  test('cold-start Plan-gate scenarios read dimensions from the draft confirmation boundary', () => {
    expect(coldStartPlanGateScenarios.map((scenario) => scenario.id).sort()).toEqual(
      [...coldStartPlanGateScenarioIds].sort()
    );

    const serializedScenarios = JSON.stringify(coldStartPlanGateScenarios);
    expect(serializedScenarios).toContain(
      'projectContextCreationGuide.confirmedPlanBoundary.dimensionIds'
    );
    expect(serializedScenarios).not.toContain('sourceReports.planningAids.selection');
    expect(serializedScenarios).not.toMatch(
      /activeDimensionIds|skippedDimensionIds|lowConfidenceDimensions/
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
