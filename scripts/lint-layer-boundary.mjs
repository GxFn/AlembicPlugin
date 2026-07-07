#!/usr/bin/env node
/**
 * lint-layer-boundary.mjs — Plugin layer-contract boundary check (RC-6).
 *
 * Enforces the one-way layer contract around the MCP surface:
 *   - L2 (MCP surface)     = lib/host-runtime/mcp/**
 *   - L1 (host-agnostic)   = lib/service/**, lib/workflows/**, non-mcp lib/host-runtime/**
 *
 * The MCP surface (L2) may import services/workflows (L1) — that is the clean
 * dependency direction (L2 → L1). The reverse is forbidden: lib/service/** and
 * lib/workflows/** must NOT import back into lib/host-runtime/mcp/** (an L1 → L2
 * backslip), which would turn the MCP boundary into a cycle instead of a thin
 * host adapter over host-agnostic services. Pull the underlying symbol from its
 * own source layer (e.g. @alembic/core, lib/shared) instead of reaching into the
 * MCP surface.
 *
 * Forbidden: an import in lib/service/** or lib/workflows/** whose specifier
 * targets lib/host-runtime/mcp — a relative path (…/runtime/mcp/…) or the
 * `#host-runtime/mcp/…` alias (`#codex` → lib/runtime).
 *
 * Exit 0 = clean, Exit 1 = backslip found.
 */
import { execSync } from 'node:child_process';

// L1 directories that must not reach into the L2 MCP surface.
const L1_DIRS = ['lib/service', 'lib/recipe-pipeline'];
// Import specifiers that resolve into lib/host-runtime (W5-f: widened from mcp/-only to the
// whole L2 host-runtime tree; the direction axiom L1 -> L2 is forbidden except the allowlist).
const PATTERN = "from '([^']*lib/host-runtime/|#host-runtime/)";

// W5-f P3 residual allowlist (decision (6)b): two host-facts builders consumed by generate
// workflows at result-assembly time. They read host-global runtime-control state / weave the
// plugin tool-surface catalog — genuinely host-runtime semantics, not movable into L1.
// Follow-up route: inject as optional hostFacts ports from the mcp handler layer (DI).
const ALLOWLIST = [
  'lib/recipe-pipeline/generate/cold-start.ts:.*buildLocalSelectionMismatch',
  'lib/recipe-pipeline/generate/cold-start.ts:.*buildColdStartOnboardingContract',
  'lib/recipe-pipeline/generate/knowledge-rescan.ts:.*buildLocalSelectionMismatch',
  // P2 WS-2: Project Skill export must resolve the per-host runtime root via L3
  // HostAdapter while keeping the actual host-name split inside adapter implementations.
  'lib/service/skills/ProjectSkillDelivery.ts:.*#host-runtime/host-adapter/resolveHostAdapter',
  // type-only bridge (no runtime coupling): resident client surfaces the host-runtime status
  // shape in its API. Follow-up: sink HostRuntimeStatus into lib/types or a Core contract.
  'lib/service/resident/AlembicResidentServiceClient.ts:.*import type \\{ HostRuntimeStatus \\}',
];

const result = execSync(
  `grep -rnE "${PATTERN}" ${L1_DIRS.join(' ')} --include='*.ts' 2>/dev/null || true`,
  { encoding: 'utf8' }
);

const allowRes = ALLOWLIST.map((p) => new RegExp(p));
const violations = [];
for (const line of result.trim().split('\n').filter(Boolean)) {
  // Skip matches inside line/block comments (mirror lint-repo-boundary.mjs).
  const colonIdx = line.indexOf(':', line.indexOf(':') + 1);
  const code = colonIdx >= 0 ? line.slice(colonIdx + 1) : line;
  const trimmed = code.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    continue;
  }
  if (allowRes.some((re) => re.test(line))) {
    continue;
  }
  violations.push(line);
}

if (violations.length > 0) {
  console.error(
    '[layer-boundary] FAIL — L1 (lib/service, lib/recipe-pipeline) must not import L2 (lib/host-runtime) outside the allowlist:'
  );
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  console.error(
    '\nFix: import the symbol from its own source layer (e.g. @alembic/core or lib/shared) instead of reaching back into lib/host-runtime/mcp. The clean direction is L2(mcp) → L1(service/workflows); L1 → L2 is a backslip.'
  );
  process.exit(1);
}

console.log(
  '[layer-boundary] PASS — no L1 → L2 backslip; the MCP surface (lib/host-runtime/mcp) imports services/workflows one-way (L2 → L1).'
);
