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

- **Where**: `lib/host-runtime/mcp/error-taxonomy.ts` —
  `LEGACY_ERROR_CODE_FAILURE_KINDS` table and
  `mapLegacyErrorCodeToFailureKind()` mapper.
- **What**: fallback chain inside `createCleanMcpFailureTaxonomy` that derives
  the structured `failureKind` from legacy string error codes (e.g.
  `CODEX_DASHBOARD_HANDOFF_UNAVAILABLE`, emitted live at
  `lib/host-runtime/mcp/CodexMcpServer.ts:768`) when a generation site does not pass
  `failureKind` explicitly.
- **Owner**: AlembicPlugin (MCP output contract).
- **Status**: keep — live runtime fallback; behavior pinned by
  `McpCleanOutputContract.test.ts` and `CodexMcpServer.test.ts`, probed by
  `scripts/probe-mcp-error-taxonomy.mjs`.
- **Retirement condition**: every failure-generation site passes `failureKind`
  explicitly (audit of all `createCleanMcpFailureTaxonomy` callers shows no
  caller relying on code-string mapping). Until then the mapping stays.

## Disposed entries

### D0 — Host identity and write-source compatibility metadata (removed 2026-07-12)

- **Was**: Plugin-side host identity fallback diagnostics and legacy caller
  write-source normalization.
- **Disposition**: removed with the standalone request-scoped MCP cleanup.
  Project identity now comes from the centralized project-location service,
  while writes record the canonical actual producer at the write boundary.

### D1 — Plugin twin `_slimSearchItem` re-export (removed in RC4, 2026-06-11)

- **Was**: `lib/host-runtime/mcp/handlers/search.ts` — deprecated backward-compat
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
  whose twin routes stayed contract-required at the time. Neither route is in
  `CODEX_EMBEDDED_RUNTIME_REQUIRED_ROUTES`. Follow-up P5 cleanup (2026-06-23)
  retired the Core `PanoramaService` implementation and removed the Plugin
  `alembic_panorama` clean-output business contract; direct calls now remain
  only as explicit retired-tool diagnostics instead of a live Panorama surface.
