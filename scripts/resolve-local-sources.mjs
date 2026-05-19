#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCoreGrammarSource, resolveCoreSource } from './local-source-paths.mjs';

const core = resolveCoreSource();
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
