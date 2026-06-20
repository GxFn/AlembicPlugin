#!/usr/bin/env node
/**
 * lint-layer-boundary.mjs — Plugin layer-contract boundary check (RC-6).
 *
 * Enforces the one-way layer contract around the MCP surface:
 *   - L2 (MCP surface)     = lib/runtime/mcp/**
 *   - L1 (host-agnostic)   = lib/service/**, lib/workflows/**, non-mcp lib/runtime/**
 *
 * The MCP surface (L2) may import services/workflows (L1) — that is the clean
 * dependency direction (L2 → L1). The reverse is forbidden: lib/service/** and
 * lib/workflows/** must NOT import back into lib/runtime/mcp/** (an L1 → L2
 * backslip), which would turn the MCP boundary into a cycle instead of a thin
 * host adapter over host-agnostic services. Pull the underlying symbol from its
 * own source layer (e.g. @alembic/core, lib/shared) instead of reaching into the
 * MCP surface.
 *
 * Forbidden: an import in lib/service/** or lib/workflows/** whose specifier
 * targets lib/runtime/mcp — a relative path (…/runtime/mcp/…) or the
 * `#codex/mcp/…` alias (`#codex` → lib/runtime).
 *
 * Exit 0 = clean, Exit 1 = backslip found.
 */
import { execSync } from 'node:child_process';

// L1 directories that must not reach into the L2 MCP surface.
const L1_DIRS = ['lib/service', 'lib/workflows'];
// Import specifiers that resolve into lib/runtime/mcp.
const PATTERN = "from '([^']*runtime/mcp/|#codex/mcp/)";

const result = execSync(
  `grep -rnE "${PATTERN}" ${L1_DIRS.join(' ')} --include='*.ts' 2>/dev/null || true`,
  { encoding: 'utf8' }
);

const violations = [];
for (const line of result.trim().split('\n').filter(Boolean)) {
  // Skip matches inside line/block comments (mirror lint-repo-boundary.mjs).
  const colonIdx = line.indexOf(':', line.indexOf(':') + 1);
  const code = colonIdx >= 0 ? line.slice(colonIdx + 1) : line;
  const trimmed = code.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    continue;
  }
  violations.push(line);
}

if (violations.length > 0) {
  console.error(
    '[layer-boundary] FAIL — L1 (lib/service, lib/workflows) must not import L2 (lib/runtime/mcp):'
  );
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  console.error(
    '\nFix: import the symbol from its own source layer (e.g. @alembic/core or lib/shared) instead of reaching back into lib/runtime/mcp. The clean direction is L2(mcp) → L1(service/workflows); L1 → L2 is a backslip.'
  );
  process.exit(1);
}

console.log(
  '[layer-boundary] PASS — no L1 → L2 backslip; the MCP surface (lib/runtime/mcp) imports services/workflows one-way (L2 → L1).'
);
