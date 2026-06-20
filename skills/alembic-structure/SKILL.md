---
name: alembic-structure
description: This project has a local Alembic knowledge base. Use Alembic recipe_map and ProjectContext graph orientation for structure and dependency questions.
---

<!-- wakeflow-shared:begin section="title-intro" -->
# Alembic — Structure & Dependencies & Project Graph

Use this skill when the user asks about **project structure**, **module targets**, **dependency graph**, project-internal relations, or source-backed navigation.
<!-- wakeflow-shared:end -->

<!-- wakeflow-host:plugin — host-context trigger line + plugin-only ProjectContext guidance -->
This project has a local Alembic knowledge base. Use compact recipe_map and ProjectContext graph orientation proactively for this project.

For current project orientation, use `alembic_recipe_map` for Recipe-mounted navigation and `alembic_graph` for bounded ProjectContext-backed structure, source, and dependency relations before broad raw Read/Grep exploration. Treat graph output as orientation evidence; use raw reads/search, Guard, and repository tests for current code behavior claims.

<!-- wakeflow-shared:begin section="tools-and-graph" -->
---

## Project Navigation Tools

| Tool | Purpose | Key Input |
|------|---------|-----------|
| `alembic_recipe_map(focus={kind:"space"})` | Compact Recipe-mounted region overview with rollups and next actions | optional `radius`, `budget`, `includeRecipes` |
| `alembic_recipe_map(focus={kind:"file", filePath})` | Map direct Recipe mounts and rollups for one file region | `filePath` |
| `alembic_recipe_map(focus={kind:"module"})` | Map module-level Recipe mounts without dumping unrelated file Recipes | optional module focus fields |

### Workflow
1. Start with `alembic_recipe_map` for the smallest useful focus.
2. Use file/module focus or graph `neighborhood` to drill into one visible ref.
3. Use raw reads/search, Guard, or repository tests for current source proof before citing code behavior.

---

## Project Graph Tools

Use project graph queries for bounded internal relationships between project, package, directory, file, and symbol nodes.

| Tool | Purpose | Key Input |
|------|---------|-----------|
| `alembic_graph(queryKind="map")` | Bounded project map and top-level relations | optional `query`, `budget` |
| `alembic_graph(queryKind="file-symbols")` | File node plus defined symbols and relations | `filePath` |
| `alembic_graph(queryKind="source-slice")` | Bounded source text around an anchor line | `filePath`, `line`, optional `radius.beforeLines/afterLines` |
| `alembic_graph(queryKind="anchor-range")` | Source slice plus nearby ProjectContext relations | `filePath`, `line`, optional `radius.relationHops` |
| `alembic_graph(queryKind="impact")` | Project impact radius from a ProjectContext ref/node | `refId`, optional `radius.maxDepth` |
| `alembic_graph(queryKind="path")` | Directed relation path between two ProjectContext refs | `fromRefId`, `toRefId` |
| `alembic_graph(queryKind="neighborhood")` | Bounded node neighborhood | `refId`, optional `relationType` |
| `alembic_graph(queryKind="stats")` | Project graph node/relation counts | - |

### When to use
- "what depends on this file or symbol?" -> `queryKind="impact"` with a `refId`
- "how are these modules connected?" -> `queryKind="path"` with `fromRefId` / `toRefId`
- "show neighboring project relations" -> `queryKind="neighborhood"` with `refId`

---

## Dependency Structure File

SPM dependency structure: `Alembic/Alembic.spmmap.json`
- Run `alembic spm-map` to refresh (supports SPM / Node / Go / JVM / Python / Dart / Rust)

---

## Related Skills

- **alembic-recipes**: Recipe content used as project standards
- **alembic-create**: After understanding structure, submit knowledge candidates
<!-- wakeflow-shared:end -->
