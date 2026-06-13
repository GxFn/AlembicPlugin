# Alembic Codex Runtime Package

`@gxfn/alembic-runtime` is the pinned npm runtime package boundary for the
Alembic Codex marketplace plugin.

This source manifest is intentionally separate from the lightweight Codex plugin
shell. `npm run prepare:codex-runtime-package` materializes a package directory
from the current build output, bundled production dependencies, and the local
AlembicCore build. `npm run verify:codex-runtime-package` proves that the
generated package can be packed, installed from a clean temp location, and
resolved through the MCP runtime entrypoint without relying on local `file:`
dependencies.

The marketplace plugin shell must pin an exact runtime package version such as
`@gxfn/alembic-runtime@0.2.0`; it must not publish `runtime.tgz`,
`runtime/`, or `node_modules/` as public plugin-shell contents.
