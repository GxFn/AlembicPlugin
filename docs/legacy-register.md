# Legacy Compatibility Register

Single ledger for every legacy compatibility path that still exists in this
repository. A legacy path may live in code only if it has an entry here with an
owner and a concrete retirement condition. When a path is removed, move its row
to the Disposed section with the removing commit.

Review trigger: any change to a file referenced below must re-check its entry.
Source sequence: `alembic-redundancy-stale-logic-cleanup` RC0 consumer map +
RC4 execution (2026-06-11).

## Active entries

### L1 — Legacy MCP error-code → failureKind mapping

- **Where**: `lib/runtime/mcp/error-taxonomy.ts` —
  `LEGACY_ERROR_CODE_FAILURE_KINDS` table and
  `mapLegacyErrorCodeToFailureKind()` mapper.
- **What**: fallback chain inside `createCleanMcpFailureTaxonomy` that derives
  the structured `failureKind` from legacy string error codes (e.g.
  `CODEX_DASHBOARD_HANDOFF_UNAVAILABLE`, emitted live at
  `lib/runtime/mcp/CodexMcpServer.ts:768`) when a generation site does not pass
  `failureKind` explicitly.
- **Owner**: AlembicPlugin (MCP output contract).
- **Status**: keep — live runtime fallback; behavior pinned by
  `McpCleanOutputContract.test.ts` and `CodexMcpServer.test.ts`, probed by
  `scripts/probe-mcp-error-taxonomy.mjs`.
- **Retirement condition**: every failure-generation site passes `failureKind`
  explicitly (audit of all `createCleanMcpFailureTaxonomy` callers shows no
  caller relying on code-string mapping). Until then the mapping stays.

### L2 — `LEGACY_IDE_AGENT_SOURCE` ('ide-agent' write source)

- **Where defined**: AlembicCore `src/shared/source-contracts.ts:3`
  (mirrored read-only in `vendor/AlembicCore`).
- **Where consumed here**: `lib/runtime/SourceBoundary.ts:2,7` — the plugin only
  imports the constant into `LEGACY_HOST_AGENT_WRITE_SOURCES` so
  `normalizeCodexHostAgentWriteSource()` rewrites legacy `'ide-agent'` (and
  other legacy write sources) to `HOST_AGENT_SOURCE`; storage read expansion
  (`proposalSourceStorageValues`) still accepts stored `'ide-agent'` rows.
- **Owner**: AlembicCore (cross-repo marker; the plugin is an importer only —
  removal must start in Core, never in this repository alone).
- **Status**: keep — live input normalization plus stored-data read expansion;
  pinned by Core `SourceContracts.test.ts`.
- **Retirement condition**: stored `'ide-agent'` data migrated (no rows with
  the legacy source remain) AND a client audit confirms no writer still sends
  it. Any earlier removal escalates to a controller decision.

### L3 — `legacyEffectiveIdentityFallback` diagnostics field

- **Where**: `lib/runtime/runtime/ProjectRuntimeContext.ts` —
  `CodexRuntimeFallbackIsolation.legacyEffectiveIdentityFallback` and the
  `CODEX_RUNTIME_FALLBACK_ISOLATION` table.
- **What**: read-only diagnostics label naming the legacy effective-identity
  fallback each isolation entry replaced; always serialized into diagnostics
  responses (`buildCodexProjectRuntimeContext`, `CodexMcpServer.ts` runtime
  context payloads). `effectiveIdentityAllowed` is `false` everywhere — the
  field never influences identity resolution.
- **Owner**: AlembicPlugin (runtime diagnostics).
- **Status**: keep — diagnostic surface; labels pinned by
  CodexRuntimeContext / CodexMcpServer tests.
- **Retirement condition**: diagnostics consumers verified independent of the
  field (no reader keys off it) AND the pinning tests are updated in the same
  change.

## Disposed entries

### D1 — `LEGACY_DIRECT_CALL_COMPATIBILITY_TOOLS` (removed in RC4, 2026-06-11)

- **Was**: `lib/runtime/mcp/tools.ts` — an always-empty array (plus derived
  `LEGACY_DIRECT_CALL_COMPATIBILITY_TOOL_NAMES` Set) kept after the
  `alembic_task` direct-call retirement, gated by a release probe asserting it
  stayed empty.
- **Disposition**: removed now — RC4 fresh 5-repo consumer scan found only the
  definition and the probe assertion
  (`scripts/probe-mcp-clean-output-final-cleanup.mjs`). The probe now asserts
  the export does not reappear instead of asserting emptiness.

### D2 — Plugin twin `_slimSearchItem` re-export (removed in RC4, 2026-06-11)

- **Was**: `lib/runtime/mcp/handlers/search.ts` — deprecated backward-compat
  wrapper around `slimSearchResult` from `@alembic/core/search`.
- **Disposition**: removed now — RC4 fresh 5-repo scan found zero consumers
  (the only remaining mention is a historical comment in Core
  `SearchTypes.ts`).

### D3 — R-1 plugin `evolution` / `panorama` HTTP read surfaces (removed in 0.3.0 RW4, 2026-06-13)

- **Was**: `lib/http/routes/evolution.ts` and `lib/http/routes/panorama.ts`
  plus their `HttpServer` mounts (`/api/v1/evolution`, `/api/v1/panorama`)
  and the panorama-only unit test `test/unit/PresentationRoutes.test.ts`.
- **Was kept at RC6** as a deadline-marked R-1 entry (AD2 register A3): the
  plugin copies were byte-identical twins of the main Alembic daemon routes
  (contract-mounted there as I22 in `provider-contracts.ts`) with no named
  plugin consumer.
- **Disposition**: deleted per the user A3 ruling (r-group-rulings
  2026-06-13: "delete in 0.3.0 with the RC4-style proof set; no consumer
  named; git-recoverable"). Fresh 5-repo scan (dynamic `import(` + HTTP path
  literals) confirmed the only importers were the plugin `HttpServer` mount
  and the panorama unit test; the Dashboard's `/panorama` + `/evolution`
  calls (`src/api.ts`, relative `/api/v1` base) reach the MAIN Alembic daemon,
  whose twin routes stay (contract-required). Neither route is in
  `CODEX_EMBEDDED_RUNTIME_REQUIRED_ROUTES`. Behavior-neutral: the MCP
  `alembic_panorama` tool and the `PanoramaService` capability are untouched
  and reachable through other surfaces; only the dead HTTP read surfaces are
  gone. Served MCP wire surface proven byte-stable (tools/list + callTool
  parity unchanged).
