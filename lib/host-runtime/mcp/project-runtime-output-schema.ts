import { z } from 'zod';

export const ProjectRuntimePublicationProvenanceSchema = z
  .object({
    mode: z.enum(['legacy', 'strict-v1']),
    routeState: z.enum(['legacy', 'ready', 'unavailable']),
    sessionId: z.string().nullable(),
    snapshotId: z.string().nullable(),
    vectorGenerationId: z.string().nullable(),
    vectorManifestHash: z.string().nullable(),
    sourceRevisionVectorHash: z.string().nullable(),
    expansionLedgerHeadHash: z.string().nullable(),
    finalExpandedScheduleHash: z.string().nullable(),
    finalCodeFactGenerationManifestHash: z.string().nullable(),
    sourceRevisionMatch: z.enum(['matched', 'mismatched', 'not-checked', 'unavailable']),
  })
  .strict();

export const StrictUnavailablePublicationProvenanceSchema =
  ProjectRuntimePublicationProvenanceSchema.safeExtend({
    mode: z.literal('strict-v1'),
    routeState: z.literal('unavailable'),
    sessionId: z.null(),
    snapshotId: z.null(),
    vectorGenerationId: z.null(),
    vectorManifestHash: z.null(),
    sourceRevisionVectorHash: z.null(),
    expansionLedgerHeadHash: z.null(),
    finalExpandedScheduleHash: z.null(),
    finalCodeFactGenerationManifestHash: z.null(),
    sourceRevisionMatch: z.literal('not-checked'),
  }).strict();

export const ProjectRuntimeContextV3Schema = z
  .object({
    contractVersion: z.literal(3),
    identity: z
      .object({
        projectRoot: z.string().min(1).max(1200),
        projectRealpath: z.string().min(1).max(1200),
        projectExists: z.boolean(),
        projectId: z.string().nullable(),
        projectScope: z.unknown().nullable(),
        projectScopeId: z.string().nullable(),
        currentFolderId: z.string().nullable(),
        registered: z.boolean(),
        ghost: z.boolean(),
        mode: z.string().min(1).max(80),
        dataRoot: z.string().min(1).max(1200),
        dataRootSource: z.string().min(1).max(1200),
        databasePath: z.string().min(1).max(1200),
        runtimeDir: z.string().min(1).max(1200),
        workspaceExists: z.boolean(),
      })
      .strict(),
    location: z
      .object({
        projectRoot: z.string().min(1).max(1200),
        projectId: z.string().nullable(),
        projectScopeId: z.string().nullable(),
        currentFolderId: z.string().nullable(),
        registered: z.boolean(),
        ghost: z.boolean(),
        dataRoot: z.string().min(1).max(1200),
        databasePath: z.string().min(1).max(1200),
        databaseExists: z.boolean(),
        runtimeDir: z.string().min(1).max(1200),
      })
      .strict(),
    publication: ProjectRuntimePublicationProvenanceSchema,
  })
  .strict();

export const StrictUnavailableProjectRuntimeContextV3Schema =
  ProjectRuntimeContextV3Schema.safeExtend({
    publication: StrictUnavailablePublicationProvenanceSchema,
  }).strict();
