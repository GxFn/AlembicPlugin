---
name: alembic-structure
description: This project has a local Alembic knowledge base. Use Alembic structure, target metadata, dependency graph, and Recipe graph context proactively for this project.
---

# Alembic — Structure & Dependencies & Knowledge Graph

This project has a local Alembic knowledge base. Use Alembic structure, target metadata, dependency graph, and Recipe graph context proactively for this project.

Use this skill when the user asks about **project structure**, **module targets**, **dependency graph**, or **knowledge graph relationships**.

For current source-code facts, follow the live MCP source graph guidance first. Call `alembic_source_graph_status`, then use visible source graph query tools such as `alembic_code_explore` or `alembic_symbol_search` before broad raw Read/Grep exploration. Use the Recipe graph tools below for knowledge relationships, not as proof that source code is fresh.

---

## Project Structure Tools

| Tool | Purpose | Key Input |
|------|---------|-----------|
| `alembic_structure(operation=targets)` | List all module Targets (file count, language stats, inferred role) | `includeSummary` |
| `alembic_structure(operation=files)` | Get source files for a Target | `targetName` (required) |
| `alembic_structure(operation=metadata)` | Target metadata (dependencies, package info, graph edges) | `targetName` (required) |

### Workflow
1. `targets` → see all Targets with roles
2. `files` → drill into specific Target
3. `metadata` → get dependencies and relations

---

## Knowledge Graph Tools

Captures **relationships between Recipes** (dependencies, extensions, conflicts, etc.).

| Tool | Purpose | Key Input |
|------|---------|-----------|
| `alembic_graph(operation=query)` | Get all relations for a Recipe node | `nodeId`, `relation`, `direction` |
| `alembic_graph(operation=impact)` | Impact analysis: downstream dependencies | `nodeId`, `maxDepth` |
| `alembic_graph(operation=path)` | Shortest path between two Recipes (BFS) | `fromId`, `toId` |
| `alembic_graph(operation=stats)` | Global graph statistics | — |

### When to use
- "修改这个 Recipe 会影响什么？" → `impact`
- "这两个模块有什么关联？" → `path`
- "知识图谱统计" → `stats`

---

## Dependency Structure File

SPM dependency structure: `Alembic/Alembic.spmmap.json`
- Run `alembic spm-map` to refresh (supports SPM / Node / Go / JVM / Python / Dart / Rust)

---

## Related Skills

- **alembic-recipes**: Recipe content used as project standards
- **alembic-create**: After understanding structure, submit knowledge candidates
