---
name: alembic-guard
description: Check code against Alembic Recipe standards with `alembic_code_guard` and explicit files, inline code, or a current workRef with scoped files when this project has local Alembic knowledge.
---

<!-- wakeflow-host:plugin — title and trigger wording are host-specific -->
# Alembic Guard

Guard checks code against project Recipes. Use it after edits only when this project has a local Alembic knowledge base or project-level Alembic knowledge skill. For empty projects, call Guard only when the user explicitly asks for Alembic Guard or compliance checking.

<!-- wakeflow-shared:begin section="scope" -->
Guard is a scoped Recipe-adherence check. It is not repo lint, security audit, general code review, or a whole-diff fallback.
<!-- wakeflow-shared:end -->

---

<!-- wakeflow-host:plugin — tool contract differs per host (plugin exposes alembic_code_guard with files/code/workRef scopes; main MCP exposes alembic_guard) -->
## Tool

Use `alembic_code_guard` for agent-facing checks. Supported public scopes are:

- explicit `files`
- inline `code` with optional `filePath` / `language`
- an active `workRef` whose current Plugin session recorded scoped files

The public contract does not accept `diffRef`, `primeRef`, `acceptedGuards`, or `applicableRecipe` as Guard scope fields yet. `alembic_guard` is a compatibility/report surface, not the agent-facing default; it no longer accepts no-args whole-diff checks and must already receive an explicit scope.

**Explicit files**:
```json
{
  "files": [
    "src/network/apiClient.ts",
    "src/network/requestManager.ts"
  ]
}
```

**Inline code**:
```json
{
  "code": "URLSession.shared.dataTask(with: url) { ... }",
  "language": "swift",
  "filePath": "Sources/Network/LegacyClient.swift"
}
```

**Current work scope**:
```json
{ "workRef": "work-public-1" }
```

The workRef form only uses source files already recorded by `alembic_work_start` / `alembic_work_finish`. If no scoped files exist, Guard returns `no-code-scope` instead of scanning unrelated repository state.

## Workflow

For quick checks:

1. Call `alembic_code_guard` with explicit files when work finish provides them, or with a current workRef when the work record has scoped files.
2. If there is no explicit file, inline-code, or scoped workRef input, report the structured blocker/skip instead of forcing a no-args check.
3. Summarize violations by severity.
4. Fix issues using returned do/dont clauses, core code, and Recipe references.
5. Re-run Guard when the fix is meaningful.

For module audits:

1. Use `alembic_project_matrix(operation: "overview")` to find relevant modules or source refs.
2. Use matrix `node` / `relations`, source graph tools, or raw reads to choose an explicit file list.
3. Call `alembic_code_guard` with selected files.
4. Report the highest-severity issues first.

---

<!-- wakeflow-shared:begin section="knowledge-source" -->
## Guard Knowledge Source

Guard uses **Recipe content** as the standard — no separate config:
- **kind=rule** → enforced as Guard rules (severity: error/warning/info)
- **kind=pattern** → best-practice references
- `constraints.guards[].pattern` → regex patterns for automated detection
<!-- wakeflow-shared:end -->

---

<!-- wakeflow-shared:begin section="related-skills" -->
## Related Skills

- **alembic-recipes**: Recipe content IS the Guard standard
<!-- wakeflow-shared:end -->
