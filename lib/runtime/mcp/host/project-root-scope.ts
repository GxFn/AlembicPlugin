import { isAbsolute } from 'node:path';
import { type CodexProjectRootResolution, resolveHostAdapter } from '../../../runtime/index.js';
import { failureResult } from '../../../runtime/mcp/host/results.js';

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
  // DH-3c: host-operation 经 L3 HostAdapter 走（L2 不再直依赖 host-specific 函数）。
  const adapter = resolveHostAdapter();
  const resolution = adapter.resolveProjectRoot({ projectRoot: projectRootArg });
  return {
    kind: 'scoped-project',
    override: {
      args: scopedArgs,
      projectRoot: projectRootArg,
      resolution,
      trusted: adapter.isTrustedProjectRoot(resolution),
    },
  };
}

export function persistTrustedCodexProjectRootScope(scope: CodexProjectRootScopeOverride): void {
  if (scope.trusted && scope.resolution.path) {
    resolveHostAdapter().writeSavedProjectRoot(scope.resolution.path);
  }
}
