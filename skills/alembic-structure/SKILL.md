---
name: alembic-structure
description: This project has a local Alembic knowledge base. Use Alembic project matrix and ProjectContext graph orientation for structure and dependency questions.
---

<!-- wakeflow-shared:begin section="title-intro" -->
# Alembic — Structure & Dependencies & Project Graph

Use this skill when the user asks about **project structure**, **module targets**, **dependency graph**, project-internal relations, or source-backed navigation.
<!-- wakeflow-shared:end -->

<!-- wakeflow-host:plugin — host-context trigger line + plugin-only ProjectContext guidance -->
This project has a local Alembic knowledge base. Use compact project matrix and ProjectContext graph orientation proactively for this project.

For current project orientation, use `alembic_project_matrix` for compact navigation and `alembic_graph` for bounded ProjectContext-backed structure, source, and dependency relations before broad raw Read/Grep exploration. Treat graph output as orientation evidence; use raw reads/search, Guard, and repository tests for current code behavior claims.

<!-- wakeflow-shared:begin section="tools-and-graph" -->
---

## Project Navigation Tools

| Tool | Purpose | Key Input |
|------|---------|-----------|
| `alembic_project_matrix(operation=overview)` | Compact hierarchy, key nodes, hotspots, project status, category summary, detail refs, and next actions | optional `query`, `activeFile`, `budget` |
| `alembic_project_matrix(operation=node)` | Expand one matrix node only | `nodeId` or `refId` |
| `alembic_project_matrix(operation=relations/layers/sources/catalog)` | Bounded relations, layer/source summaries, or category catalog | optional node/query filters |

### Workflow
1. Start with matrix `overview` for the smallest useful map.
2. Use matrix `node` or `relations` to drill into one visible ref.
3. Use raw reads/search, Guard, or repository tests for current source proof before citing code behavior.

---

## Project Graph Tools

Use project graph queries for bounded internal relationships between project, package, directory, file, and symbol nodes.

| Tool | Purpose | Key Input |
|------|---------|-----------|
| `alembic_graph(operation=query)` | List bounded project graph nodes/relations | `nodeType`, `query`, `relationType` |
| `alembic_graph(operation=impact)` | Project impact radius from a project, file, or symbol node | `nodeId`, `maxDepth` |
| `alembic_graph(operation=path)` | Directed project relation path between two nodes | `fromId`, `toId` |
| `alembic_graph(operation=stats)` | Project graph node/relation counts | - |
| `alembic_graph(operation=neighborhood)` | Bounded node neighborhood | `nodeId`, optional `relationType` |

### When to use
- "what depends on this file or symbol?" -> `impact`
- "how are these modules connected?" -> `path`
- "show neighboring project relations" -> `neighborhood`

---

## Dependency Structure File

SPM dependency structure: `Alembic/Alembic.spmmap.json`
- Run `alembic spm-map` to refresh (supports SPM / Node / Go / JVM / Python / Dart / Rust)

---

## Related Skills

- **alembic-recipes**: Recipe content used as project standards
- **alembic-create**: After understanding structure, submit knowledge candidates
<!-- wakeflow-shared:end -->
