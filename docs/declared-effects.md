# Declared Effects — MCP Tool Surface (P2 AD6, 2026-06-12)

The Plugin's only public entrypoint family is one ordinary MCP tool surface
shared by both host shells. Per-class declarations;
companion proof: `test/unit/McpEntrypointEffects.test.ts` (representative
call per class, sandboxed ALEMBIC_HOME, outside probe dir, never real
`~/.asd`).

## Effect classes

| Class | Tools (representatives) | Declared effects |
| --- | --- | --- |
| Read-only / knowledge query | status, diagnostics, search, recipe_map, prime, code_guard | Reads only the location resolved from the request project root; no network beyond injected providers and no automatic initialization. |
| Structure query | graph | Never writes knowledge data and never initializes the project. On an initialized project its CodeGraph session data and source index stay under the request data root. On an uninitialized project it still answers, and keeps that runtime data under a per-user temp root outside the repository (`<os tmpdir>/alembic-graph-runtime-<uid>/<project hash>`, owner-only; a process-private `mkdtemp` root if that path fails the ownership/permission check). |
| Session/work flow | work, code_guard | Session-scoped state stays inside the request data root; explicit files, inline code, or a scoped work reference define Guard input. |
| Knowledge write | submit_knowledge, dimension_complete, project_skill, knowledge_lifecycle | Writes are confined to the request data root and explicit host export locations; Recipe evidence gates precede persistence. |
| Init and maintenance | init, plan, bootstrap, rescan, job, runtime cleanup | Initialization and jobs use the request-scoped project location. Rebuild and cleanup keep explicit confirmation and path-confinement protections. |

## Uninitialized projects (no knowledge database)

Nothing is initialized automatically, and no file is written into the
repository. The expected order is `alembic_status` -> `alembic_init` ->
`alembic_plan` (draft, then confirm) -> `alembic_bootstrap`.

- Write tools that need the plugin-owned project container (for example
  work, submit_knowledge, dimension_complete, project_skill,
  knowledge_lifecycle, plan, bootstrap, rescan) and `alembic_job`
  `op=bootstrap|rescan` are refused before any container, database, log or job
  record is created. They return `PROJECT_NOT_INITIALIZED` with a required
  `nextActions` entry for `alembic_init`.
- prime, search and recipe_map return `ok=true` with `status=degraded` and a
  `knowledge-database-unavailable` diagnostic that points to `alembic_init`.
- code_guard returns `ok=true` with `status=skipped`: Guard did not run, so the
  result is not a pass.
- graph keeps working, with runtime data in the temp root described above.

## Staging access sweep (write path)

Before the handler of `alembic_submit_knowledge`, `alembic_dimension_complete`
and `alembic_rescan` (including `alembic_job op=rescan`) on an initialized
project, the plugin runs a bounded tick-on-access sweep inside the request
data root: staging promotion, lifecycle timeouts, observing proposals and
decay scanning, plus a vector index reconcile at most every 5 minutes. It is
throttled to one run per project root every 15 s, handles at most 50 items per
driver per run (`ALEMBIC_STAGING_ACCESS_SWEEP_CAP`), and the tool waits for it
at most 2 s. A skip, timeout or failure is logged and never blocks or changes
the tool result; no sweep output is added to tool responses.
Read-only tools, local tools, and uninitialized projects never sweep.

## Hard boundary facts (re-pinned)

- Project identity comes only from the current MCP request and the centralized
  project-location service; host-global runtime state is not consulted.
- Excluded-project redirection sends dev-repo data roots to tmp; tests
  always sandbox `ALEMBIC_HOME` (t1 per-worker pattern).
