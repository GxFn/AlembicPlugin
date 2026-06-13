# Declared Effects — MCP Tool Surface (P2 AD6, 2026-06-12)

The Plugin's only public entrypoint family is the tier-composed MCP tool
surface (agent 26 / usable 39, dual-host shells). Per-class declarations;
companion proof: `test/unit/McpEntrypointEffects.test.ts` (representative
call per class, sandboxed ALEMBIC_HOME, outside probe dir, never real
`~/.asd`).

## Effect classes

| Class | Tools (representatives) | Declared effects |
| --- | --- | --- |
| Read-only / knowledge query | search, knowledge, structure, graph, call_context, callers/callees, code_explore, symbol_search, panorama, health, source_graph_status, codex_status, codex_diagnostics, intent, prime | No writes outside the configured data root; no network beyond injected providers; never touch Alembic-owned `runtime-control.json` (read-only consult in alignment checks only). |
| Session/work flow | work_start, work_finish, code_guard, decision_record, guard, affected_tests, validation_plan | Session-scoped state inside the data root (audit/session records); no external writes. |
| Knowledge write | submit_knowledge, evolve, consolidate, dimension_complete, project_skill, knowledge_lifecycle (admin) | Writes confined to the data root (DB + knowledge projections + skill exports under the project's `.agents/skills`); recipe evidence gates precede persistence. |
| Destructive / init | bootstrap, rescan, codex_init, codex_bootstrap/codex_rescan (daemon jobs) | Writes ONLY under the configured data root + the ALEMBIC_HOME project registry (projects.json); t6 gates: rescan archives projections to `.asd/.trash/<ts>/`, bare bootstrap on a usable KB requires `rebuild:true` and announces the archive; daemon-job routes selection-gated (t6 P3-3). |
| Daemon control | codex_job, codex_dashboard, codex_stop, codex_cleanup | Daemon runtime state under the project's daemon paths; dashboard handoff requires connected runtime; stop/cleanup destructive class (pending USER sheet decision). |

## Hard boundary facts (re-pinned)

- The plugin NEVER writes Alembic-owned surfaces: `runtime-control.json`
  is read-only here (asserted by the effects tests; established at
  t6/t12; the charter must-never line).
- Excluded-project redirection sends dev-repo data roots to tmp; tests
  always sandbox `ALEMBIC_HOME` (t1 per-worker pattern).
