import type {
  AlembicResidentServiceProbe,
  AlembicResidentServiceResult,
} from '@alembic/core/daemon';
import {
  type AlembicResidentJobRequestOptions,
  type AlembicResidentProbeOptions,
  type AlembicResidentProjectScopeIdentity,
  type AlembicResidentProjectScopeOptions,
  AlembicResidentServiceClient,
  type AlembicResidentServiceClientOptions,
  type ResidentPrimeRequest,
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

  prime(request: ResidentPrimeRequest): Promise<ResidentSearchResult> {
    return this.client.prime(request);
  }

  primeWithResult(
    request: ResidentPrimeRequest
  ): Promise<AlembicResidentServiceResult<ResidentSearchResult>> {
    return this.client.primeWithResult(request);
  }

  search(request: ResidentSearchRequest): Promise<ResidentSearchResult> {
    return this.client.search(request);
  }

  searchWithResult(
    request: ResidentSearchRequest
  ): Promise<AlembicResidentServiceResult<ResidentSearchResult>> {
    return this.client.searchWithResult(request);
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

export interface AlembicResidentCapabilityClients {
  jobs: ResidentJobClient;
  probe: ResidentProbeClient;
  projectScope: ResidentProjectScopeClient;
  search: ResidentSearchClient;
}

export function createAlembicResidentCapabilityClients(
  options: AlembicResidentServiceClientOptions
): AlembicResidentCapabilityClients {
  const client = new AlembicResidentServiceClient(options);
  return {
    jobs: new ResidentJobClient(client),
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
