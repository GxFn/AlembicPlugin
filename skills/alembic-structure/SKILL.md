---
name: alembic-structure
description: This project has a local Alembic knowledge base. Use Alembic project matrix, project graph, and source graph context for structure and dependency questions.
---

<!-- wakeflow-shared:begin section="title-intro" -->
# Alembic — Structure & Dependencies & Project Graph

Use this skill when the user asks about **project structure**, **module targets**, **dependency graph**, project-internal relations, or source-backed navigation.
<!-- wakeflow-shared:end -->

<!-- wakeflow-host:plugin — host-context trigger line + plugin-only source-graph guidance (alembic_source_graph_status / alembic_code_explore / alembic_symbol_search are not in the main MCP) -->
This project has a local Alembic knowledge base. Use compact project matrix, project graph, and source graph context proactively for this project.

For current source-code facts, follow the live MCP source graph guidance first. Call `alembic_source_graph_status`, then use visible source graph query tools such as `alembic_code_explore` or `alembic_symbol_search` before broad raw Read/Grep exploration. Use `alembic_project_matrix` for compact navigation and `alembic_graph` only for bounded project-internal structure/source/dependency relations.

<!-- wakeflow-shared:begin section="tools-and-graph" -->
---

## Project Navigation Tools

| Tool | Purpose | Key Input |
|------|---------|-----------|
| `alembic_project_matrix(operation=overview)` | Compact hierarchy, key nodes, hotspots, source status, category summary, detail refs, and next actions | optional `query`, `activeFile`, `budget` |
| `alembic_project_matrix(operation=node)` | Expand one matrix node only | `nodeId` or `refId` |
| `alembic_project_matrix(operation=relations/layers/sources/catalog)` | Bounded relations, layer/source summaries, or category catalog | optional node/query filters |

### Workflow
1. Start with matrix `overview` for the smallest useful map.
2. Use matrix `node` or `relations` to drill into one visible ref.
3. Use source graph tools for current source proof before citing code behavior.

---

## Project Graph Tools

Use project graph queries for bounded internal relationships between project, package, directory, file, symbol, and source-graph nodes.

| Tool | Purpose | Key Input |
|------|---------|-----------|
| `alembic_graph(operation=query)` | List bounded project graph nodes/relations | `nodeType`, `query`, `relationType` |
| `alembic_graph(operation=impact)` | Project impact radius from a project/source node | `nodeId`, `maxDepth` |
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
