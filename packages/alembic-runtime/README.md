# Alembic Codex Runtime Package

`alembic-runtime` is the pinned npm runtime package boundary for the
Alembic Codex marketplace plugin.

This source manifest is intentionally separate from the lightweight Codex plugin
shell. `npm run prepare:codex-runtime-package` materializes a package directory
from the current build output and the local AlembicCore build. The private Core
package is bundled; its production dependencies and versions are copied from
Core's manifest into the generated runtime manifest, alongside host dependencies.
Maintain Core-owned dependencies in Core rather than duplicating them here.

`npm run verify:codex-runtime-package` installs only the generated runtime tarball
in a clean temporary location, loads the MCP entrypoint, and runs a real CodeGraph
symbol extraction with worker cleanup. Its reported install mode distinguishes
normal npm installation from the explicitly marked workspace dependency fallback
used when DNS is unavailable.

The marketplace plugin shell must pin an exact runtime package version such as
`alembic-runtime@0.2.0`; it must not publish `runtime.tgz`,
`runtime/`, or `node_modules/` as public plugin-shell contents.
