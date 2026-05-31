# Architecture Recipe Loop Acceptance Pack

This pack is for a real Codex thread, not for the retired scenario simulator. It verifies the
Plugin-owned cold-start / rescan Recipe loop for one dimension only: `architecture`.

## Scope

- Target repository: one disposable fixture project or a user-approved test project.
- Dimension: `architecture`.
- Tool path: Codex MCP tools owned by AlembicPlugin.
- Out of scope: resident daemon jobs, packaged runtime parity, Dashboard, real product projects,
  external AI providers, API keys, Core public contract changes.

## Tool Order

1. Call `alembic_bootstrap` with the target `projectRoot`.
2. Read the Mission Briefing and prepare one architecture Recipe candidate.
3. Call `alembic_submit_knowledge` with exactly one architecture item whose `reasoning.sources`
   points at a real source file in the fixture project.
4. Call `alembic_dimension_complete` with `dimensionId: "architecture"` and the submitted Recipe id.
5. Confirm one Recipe is persisted in `knowledge_entries` and as a Recipe markdown file.
6. Call `alembic_rescan` with `dimensions: ["architecture"]`.
7. Run `node scripts/check-codex-recipe-loop-evidence.mjs` against the project root and transcript.

## Required Evidence

- The transcript contains the ordered subset:
  `alembic_bootstrap -> alembic_submit_knowledge -> alembic_dimension_complete -> alembic_rescan`.
- `alembic_rescan` was called with `dimensions: ["architecture"]`.
- The submitted Recipe id remains present after rescan.
- `knowledge_entries` has at least one architecture entry with lifecycle and source reference data.
- `recipe_source_refs` or `reasoning.sources` / `sourceFile` proves source reference capture.
- The rescan tool result contains an `evidencePlan`.
- The final database state has no duplicate architecture Recipe by title, trigger, or coreCode.

## Stop Conditions

- Stop and report a product-chain breakpoint if any required tool fails.
- Stop and report a product-chain breakpoint if no Recipe is persisted before rescan.
- Stop and report a product-chain breakpoint if rescan returns no `evidencePlan`.
- Do not repair cold-start / rescan product behavior inside this acceptance run.

