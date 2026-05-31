import { isAbsolute } from 'node:path';
import {
  type CodexProjectRootResolution,
  isTrustedCodexProjectRoot,
  resolveCodexProjectRoot,
  writeCodexSavedProjectRoot,
} from '../../../codex/index.js';
import { failureResult } from './results.js';

export interface CodexProjectRootScopeOverride {
  args: Record<string, unknown>;
  projectRoot: string;
  resolution: CodexProjectRootResolution;
  trusted: boolean;
}

export type CodexProjectRootScopeDecision =
  | {
      kind: 'current-project';
      args: Record<string, unknown>;
    }
  | {
      kind: 'failure';
      result: unknown;
    }
  | {
      kind: 'scoped-project';
      override: CodexProjectRootScopeOverride;
    };

export function resolveCodexProjectRootScope(
  toolName: string,
  args: Record<string, unknown>
): CodexProjectRootScopeDecision {
  const projectRootArg = args.projectRoot;
  if (projectRootArg === undefined) {
    return { kind: 'current-project', args };
  }
  if (typeof projectRootArg !== 'string' || projectRootArg.trim().length === 0) {
    return {
      kind: 'failure',
      result: failureResult(toolName, 'projectRoot must be a non-empty absolute path string.', {
        errorCode: 'CODEX_INVALID_PROJECT_ROOT_ARGUMENT',
        required: { projectRoot: 'absolute path' },
      }),
    };
  }
  if (!isAbsolute(projectRootArg)) {
    return {
      kind: 'failure',
      result: failureResult(toolName, 'projectRoot must be an absolute path.', {
        errorCode: 'CODEX_INVALID_PROJECT_ROOT_ARGUMENT',
        received: projectRootArg,
        required: { projectRoot: 'absolute path' },
      }),
    };
  }

  const scopedArgs = { ...args };
  delete scopedArgs.projectRoot;
  const resolution = resolveCodexProjectRoot({ projectRoot: projectRootArg });
  return {
    kind: 'scoped-project',
    override: {
      args: scopedArgs,
      projectRoot: projectRootArg,
      resolution,
      trusted: isTrustedCodexProjectRoot(resolution),
    },
  };
}

export function persistTrustedCodexProjectRootScope(scope: CodexProjectRootScopeOverride): void {
  if (scope.trusted && scope.resolution.path) {
    writeCodexSavedProjectRoot(scope.resolution.path);
  }
}
