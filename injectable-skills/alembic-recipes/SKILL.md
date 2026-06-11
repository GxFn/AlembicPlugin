---
name: alembic-recipes
description: This project has a local Alembic knowledge base. Use Alembic Recipes, Guard context, and knowledge search proactively for this project when coding or answering project-standard questions.
---

<!-- wakeflow-shared:begin section="title" -->
# Alembic Recipe Context (Project Context)
<!-- wakeflow-shared:end -->

<!-- wakeflow-host:plugin — host-context trigger line -->
This project has a local Alembic knowledge base. Use Alembic Recipes, Guard context, and knowledge search proactively for this project when coding or answering project-standard questions.

<!-- wakeflow-shared:begin section="intro-and-overview" -->
This skill provides the agent with this project's context from Alembic Recipes. Recipes are the project's standard knowledge base: code patterns, usage guides, and structured relations.

---

## Knowledge Base Overview

| Part | Location | Purpose |
|------|----------|---------|
| **Recipes** | `Alembic/recipes/*.md` | Standard code patterns + usage guides; used for AI context, Guard, search |
| **Snippets** | `Alembic/snippets/*.json` | Code snippets synced to IDE via `alembic install` |
| **Candidates** | `Alembic/.asd/candidates.json` | AI-scanned candidates; review in Dashboard then approve |
| **Context index** | `Alembic/.asd/context/` | Vector index built by `alembic embed`; semantic search via `alembic_search(mode=context)` |

**Recipe** = one `.md` file = one specific usage pattern or code snippet. **kind**: `rule` (Guard enforced) / `pattern` (best practice) / `fact` (structural knowledge). **Recipe over project code**: When both exist, prefer Recipe as curated standard.

---

## Agent Permission Boundary

| Allowed | Forbidden |
|---------|-----------|
| Submit candidates (`alembic_submit_knowledge` / `_batch`) | Directly create/modify Recipes |
| Search/query (`alembic_search` / `alembic_knowledge`) | Publish/deprecate/delete |
| Confirm usage (`confirm_usage`) | Write to `Alembic/recipes/` |

---

## How to Find Recipes

1. **In-context index**: Read `references/project-recipes-context.md` in this skill folder
2. **MCP browse**: `alembic_knowledge(operation=list)` with kind/language/category filters
3. **MCP get**: `alembic_knowledge(operation=get, id)` for full content
<!-- wakeflow-shared:end -->
<!-- wakeflow-host:plugin — search description is host-specific (plugin: baseline plus resident enhancement) -->
4. **MCP search**: `alembic_search(mode=auto)` for unified baseline search plus resident semantic/vector enhancement when local Alembic is ready
<!-- wakeflow-shared:begin section="find-recipes-tail" -->
5. **Terminal**: `alembic search <keyword>`

**Recipe over code search**: When both find matches, prefer Recipe as source of truth. Cite Recipe title.
<!-- wakeflow-shared:end -->

<!-- wakeflow-host:plugin — structuredContent contract and plugin-only diagnostics tools (alembic_prime / alembic_codex_diagnostics / alembic_codex_status) -->
Use the clean `structuredContent` fields returned by `alembic_prime` and `alembic_search` as the Recipe context contract. Runtime diagnostics such as resident route or vector availability belong in `alembic_codex_diagnostics` / `alembic_codex_status`, not in ordinary Recipe guidance.

<!-- wakeflow-shared:begin section="use-context-head" -->
---

## How to Use This Context

1. **Project standards/Guard**: Use Recipe content as source of truth
2. **"How we do X here"**: Base answer on Recipe content
3. **Suggesting code**: Cite Recipe's code snippet, not raw search results
<!-- wakeflow-shared:end -->
<!-- wakeflow-host:plugin — Guard tool naming differs per host (plugin: alembic_code_guard with explicit scope) -->
4. **Guard/Audit**: `// as:audit` or MCP `alembic_code_guard` with explicit files, inline code, or current workRef scope — all use Recipes as standard
<!-- wakeflow-shared:begin section="use-context-tail" -->
5. **Confirm adoption**: `alembic_knowledge(operation=confirm_usage, id, usageType)` when user uses a Recipe

---

## Auto-Extracting Headers for New Candidates

1. **From code** (Recommended): Extract all import statements from user's code
2. **From existing Recipes**: Check index for matching modules, then `alembic_knowledge(operation=get, id)` for full content
3. **Via semantic search**: `alembic_search(mode=context)` with query like "import ModuleName"

---

## Related Skills

- **alembic-create**: Submit knowledge candidates (V3 fields, validation, lifecycle)
- **alembic-guard**: Code compliance checking against Recipe standards
- **alembic-structure**: Project structure and knowledge graph
<!-- wakeflow-shared:end -->
