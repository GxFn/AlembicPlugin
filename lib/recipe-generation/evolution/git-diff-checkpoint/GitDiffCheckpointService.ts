import { GitDiffCheckpointService as CoreGitDiffCheckpointService } from '@alembic/core/evolution';

export { CoreGitDiffCheckpointService as GitDiffCheckpointService };
export type {
  EnsureGitDiffCheckpointInput,
  EnsureGitDiffCheckpointResult,
  GitDiffCheckpointInitializationSource,
  GitDiffCheckpointRecord,
  GitDiffCheckpointRouteStatus,
  GitDiffCheckpointScope,
  RecordGitDiffCheckpointRouteInput,
  RecordGitDiffCheckpointRouteResult,
} from '@alembic/core/evolution';

export type GitDiffCheckpointServiceOptions = ConstructorParameters<
  typeof CoreGitDiffCheckpointService
>[0];
export type GitDiffCheckpointResult = ReturnType<
  CoreGitDiffCheckpointService['recordRouteOutcome']
>;
