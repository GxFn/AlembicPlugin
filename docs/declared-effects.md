# Declared Effects — MCP Tool Surface (P2 AD6, 2026-06-12)

The Plugin's only public entrypoint family is one ordinary MCP tool surface
shared by both host shells. Per-class declarations;
companion proof: `test/unit/McpEntrypointEffects.test.ts` (representative
call per class, sandboxed ALEMBIC_HOME, outside probe dir, never real
`~/.asd`).

## Effect classes

| Class | Tools (representatives) | Declared effects |
| --- | --- | --- |
| Read-only / knowledge query | status, diagnostics, search, graph, recipe_map, prime, code_guard | Reads only the location resolved from the request project root; no network beyond injected providers and no automatic initialization. |
| Session/work flow | work, code_guard | Session-scoped state stays inside the request data root; explicit files, inline code, or a scoped work reference define Guard input. |
| Knowledge write | submit_knowledge, dimension_complete, project_skill, knowledge_lifecycle | Writes are confined to the request data root and explicit host export locations; Recipe evidence gates precede persistence. |
| Init and maintenance | init, bootstrap, rescan, job, runtime cleanup | Initialization and jobs use the request-scoped project location. Rebuild and cleanup keep explicit confirmation and path-confinement protections. |

## Hard boundary facts (re-pinned)

- Project identity comes only from the current MCP request and the centralized
  project-location service; host-global runtime state is not consulted.
- Excluded-project redirection sends dev-repo data roots to tmp; tests
  always sandbox `ALEMBIC_HOME` (t1 per-worker pattern).
