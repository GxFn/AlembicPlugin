/** Vitest 测试环境设置 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';

// Test isolation boundary: the Plugin repo is an excluded project, so Core's
// WorkspaceResolver ghost mode routes runtime data (alembic.db, projects.json,
// vector store) to <user home>/.asd/workspaces/<id>. Without a sandbox every
// vitest worker reads AND writes the developer's real ~/.asd ghost workspace —
// parallel workers corrupted that real DB (P3 plugin-train step 0 evidence;
// same defect class as the Train H MT-harness isolation finding). ALEMBIC_HOME
// takes precedence over HOME in Core's getUserHome(), so a per-worker temp dir
// keeps the whole registry + ghost-workspace chain inside the sandbox and
// gives each worker its own database.
process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-plugin-vitest-'));

export default {};
