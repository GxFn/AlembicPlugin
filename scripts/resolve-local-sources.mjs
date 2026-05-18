#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveCoreGrammarSource,
  resolveCoreSource,
  resolveDashboardSource,
} from './local-source-paths.mjs';

const core = resolveCoreSource();
const dashboard = resolveDashboardSource();
const grammars = resolveCoreGrammarSource();

process.stdout.write(
  `${JSON.stringify(
    {
      core: {
        label: core.label,
        commit: core.commit,
        hasDist: existsSync(join(core.path, 'dist')),
        hasPackageJson: existsSync(join(core.path, 'package.json')),
      },
      dashboard: {
        label: dashboard.label,
        commit: dashboard.commit,
        hasDist: existsSync(join(dashboard.path, 'dist')),
        hasPackageJson: existsSync(join(dashboard.path, 'package.json')),
      },
      coreGrammars: {
        label: grammars.label,
        hasTypeScriptGrammar: existsSync(join(grammars.path, 'tree-sitter-typescript.wasm')),
      },
      runtimeCoreDependency: 'file:vendor/AlembicCore',
    },
    null,
    2
  )}\n`
);
