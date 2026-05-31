import type {
  AlembicResidentDashboardHandoff,
  AlembicResidentServiceProbe,
  AlembicResidentServiceResult,
} from '@alembic/core/daemon';
import type { DaemonStatus } from '../../daemon/DaemonSupervisor.js';
import {
  type AlembicResidentJobRequestOptions,
  type AlembicResidentProbeOptions,
  type AlembicResidentProjectScopeIdentity,
  type AlembicResidentProjectScopeOptions,
  AlembicResidentServiceClient,
  type AlembicResidentServiceClientOptions,
  type ResidentIntentEpisodeOutcomeRequest,
  type ResidentIntentEpisodeReadOptions,
  type ResidentIntentEpisodeResult,
  type ResidentIntentEpisodeStartRequest,
  type ResidentSearchRequest,
  type ResidentSearchResult,
} from './AlembicResidentServiceClient.js';

export class ResidentProbeClient {
  constructor(private readonly client: AlembicResidentServiceClient) {}

  probe(options: AlembicResidentProbeOptions = {}): Promise<AlembicResidentServiceProbe> {
    return this.client.probe(options);
  }
}

export class ResidentProjectScopeClient {
  constructor(private readonly client: AlembicResidentServiceClient) {}

  resolveProjectScopeIdentity(
    options: AlembicResidentProjectScopeOptions = {}
  ): Promise<AlembicResidentProjectScopeIdentity> {
    return this.client.resolveProjectScopeIdentity(options);
  }
}

export class ResidentSearchClient {
  constructor(private readonly client: AlembicResidentServiceClient) {}

  search(request: ResidentSearchRequest): Promise<ResidentSearchResult> {
    return this.client.search(request);
  }

  searchWithResult(
    request: ResidentSearchRequest
  ): Promise<AlembicResidentServiceResult<ResidentSearchResult>> {
    return this.client.searchWithResult(request);
  }
}

export class ResidentIntentEpisodeClient {
  constructor(private readonly client: AlembicResidentServiceClient) {}

  latestIntentEpisode(
    options: ResidentIntentEpisodeReadOptions = {}
  ): Promise<AlembicResidentServiceResult<ResidentIntentEpisodeResult>> {
    return this.client.latestIntentEpisode(options);
  }

  recentIntentEpisodes(
    options: ResidentIntentEpisodeReadOptions = {}
  ): Promise<AlembicResidentServiceResult<ResidentIntentEpisodeResult>> {
    return this.client.recentIntentEpisodes(options);
  }

  startIntentEpisode(
    request: ResidentIntentEpisodeStartRequest
  ): Promise<AlembicResidentServiceResult<ResidentIntentEpisodeResult>> {
    return this.client.startIntentEpisode(request);
  }

  updateIntentEpisodeOutcome(
    episodeId: string,
    request: ResidentIntentEpisodeOutcomeRequest
  ): Promise<AlembicResidentServiceResult<ResidentIntentEpisodeResult>> {
    return this.client.updateIntentEpisodeOutcome(episodeId, request);
  }
}

export class ResidentJobClient {
  constructor(private readonly client: AlembicResidentServiceClient) {}

  enqueueJob(
    kind: 'bootstrap' | 'rescan',
    options: AlembicResidentJobRequestOptions = {}
  ): Promise<AlembicResidentServiceResult<unknown>> {
    return this.client.enqueueJob(kind, options);
  }

  readJob(
    args: Record<string, unknown>,
    options: AlembicResidentProbeOptions = {}
  ): Promise<AlembicResidentServiceResult<unknown>> {
    return this.client.readJob(args, options);
  }
}

export class ResidentDashboardClient {
  constructor(private readonly client: AlembicResidentServiceClient) {}

  dashboard(
    options: AlembicResidentProbeOptions = {}
  ): Promise<AlembicResidentServiceResult<AlembicResidentDashboardHandoff>> {
    return this.client.dashboard(options);
  }
}

export interface AlembicResidentCapabilityClients {
  dashboard: ResidentDashboardClient;
  jobs: ResidentJobClient;
  intentEpisodes: ResidentIntentEpisodeClient;
  probe: ResidentProbeClient;
  projectScope: ResidentProjectScopeClient;
  search: ResidentSearchClient;
}

export function createAlembicResidentCapabilityClients(
  options: AlembicResidentServiceClientOptions
): AlembicResidentCapabilityClients {
  const client = new AlembicResidentServiceClient(options);
  return {
    dashboard: new ResidentDashboardClient(client),
    jobs: new ResidentJobClient(client),
    intentEpisodes: new ResidentIntentEpisodeClient(client),
    probe: new ResidentProbeClient(client),
    projectScope: new ResidentProjectScopeClient(client),
    search: new ResidentSearchClient(client),
  };
}

export function isResidentProjectScopeReady(
  identity: AlembicResidentProjectScopeIdentity | null | undefined
): boolean {
  return (
    identity?.available === true &&
    identity.mode === 'project-scope' &&
    identity.resident.owner === 'alembic' &&
    identity.resident.route === 'local-alembic-daemon'
  );
}

export type ResidentDashboardStatusInput = { daemonStatus?: DaemonStatus | null };
