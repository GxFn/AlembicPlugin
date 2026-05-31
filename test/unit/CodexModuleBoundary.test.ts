import { describe, expect, it } from 'vitest';
import { buildCodexModuleBoundaryStatus } from '../../lib/codex/ModuleBoundary.js';
import { getPackageVersion } from '../../lib/shared/package-assets.js';

describe('Codex module boundary status', () => {
  it('keeps Codex plugin ownership separate from Alembic runtime ownership', () => {
    const status = buildCodexModuleBoundaryStatus();
    const pluginOwned = status.pluginOwns.map((entry) => entry.id);
    const externalOwned = status.pluginDoesNotOwn.map((entry) => entry.id);

    expect(pluginOwned).toEqual([
      'codex-entry',
      'host-agent-tool-route',
      'marketplace-artifact',
      'portable-runtime-packaging',
      'dashboard-url-handoff',
      'host-project-mismatch-presentation',
    ]);
    expect(status.phase).toBe('unified-resident-service-phase-4-behavior-cleanup');
    expect(externalOwned).toContain('alembic-daemon-main');
    expect(externalOwned).toContain('project-registry-main');
    expect(externalOwned).toContain('job-store-main');
    expect(externalOwned).toContain('file-monitor-main');
    expect(externalOwned).toContain('internal-ai-runtime');
    expect(externalOwned).toContain('dashboard-frontend-source');
  });

  it('records Dashboard as an external source with only URL handoff retained', () => {
    const status = buildCodexModuleBoundaryStatus();

    expect(status.dashboard).toMatchObject({
      artifactPath: null,
      buildCommand: null,
      deletionCompletedThisWave: true,
      pluginRole: 'dashboard-url-handoff-only',
      sourceOwner: 'Alembic/AlembicDashboard',
    });
    expect(status.dashboard.pluginDoesNotBuildOrServe).toContain(
      'embedded runtime Dashboard frontend directory'
    );
  });

  it('marks embedded runtime as a Plugin adapter rather than daemon source of truth', () => {
    const status = buildCodexModuleBoundaryStatus({
      enhancementRoute: {
        embeddedRuntime: {
          artifact: './runtime.tgz',
          available: true,
          packageName: 'alembic-codex-plugin-runtime',
          route: 'embedded-plugin-runtime',
          version: getPackageVersion(),
        },
        hostAgentRoute: {
          requiresAiProvider: false,
          source: 'host-agent',
          tools: [
            'alembic_bootstrap',
            'alembic_rescan',
            'alembic_submit_knowledge',
            'alembic_dimension_complete',
          ],
        },
        internalAiProvider: {
          available: false,
          configSource: 'empty',
          model: null,
          provider: null,
        },
        localAlembic: {
          daemon: {
            available: false,
            capabilities: {
              apiAvailable: null,
              dashboardAvailable: null,
              dashboardUrl: null,
              fileMonitorAvailable: null,
              fileMonitorMode: null,
              internalAiAvailable: null,
              jobsAvailable: null,
              jobKinds: [],
            },
            compatibility: {
              runtimeBoundary: {
                activeFallback: false,
                canonicalResidentServicePresent: false,
                consumer: null,
                deletionCondition: null,
                reason: null,
                retained: false,
                source: null,
              },
            },
            dashboardUrl: null,
            healthVersion: null,
            packageName: null,
            ready: false,
            route: null,
            runtimeBoundary: {
              available: false,
              dashboard: {
                frontendOwner: null,
                handoff: null,
                serverOwner: null,
                url: null,
              },
              daemon: {
                apiBaseUrl: null,
                mode: null,
                owner: null,
                stateContract: null,
              },
              fileMonitor: {
                available: null,
                longLivedOwner: null,
                mode: null,
              },
              internalAi: {
                available: null,
                owner: null,
                runtimeOwner: null,
              },
              jobs: {
                kinds: [],
                owner: null,
                store: null,
              },
              owner: null,
              route: null,
              source: null,
              workspace: {
                contract: null,
                databasePath: null,
                dataRoot: null,
                dataRootSource: null,
                mode: null,
                projectId: null,
                projectRoot: null,
                runtimeDir: null,
              },
            },
            status: 'stopped',
            version: null,
          },
          install: {
            available: false,
            command: 'alembic',
            error: 'not found',
            version: null,
          },
        },
        missingCapabilities: ['daemon-api'],
        reason: 'No local Alembic daemon API is ready.',
        requirement: 'jobs',
        selected: 'embedded-plugin-runtime',
      },
    });

    expect(status.adapters.enhancementRoute).toMatchObject({
      consumesLocalAlembicCapabilities: false,
      hostAgentSource: 'host-agent',
      internalAiProviderIsProviderStateOnly: true,
      missingCapabilities: ['daemon-api'],
      selected: 'embedded-plugin-runtime',
    });
    expect(status.adapters.embeddedRuntime.role).toContain('not the long-term Alembic daemon');
    expect(status.adapters.hostProjectAlignment).toMatchObject({
      connectionState: null,
      handoffAllowed: null,
      switchOwnership: 'Alembic/Dashboard',
    });
    expect(status.adapters.runtimeContract).toMatchObject({
      capabilitySummarySource:
        '@alembic/core/daemon#residentService and explicit capability sections',
      healthPath: '/api/v1/daemon/health',
      residentServiceOwner: null,
      residentServiceRoute: null,
      runtimeBoundaryAvailable: false,
    });
    expect(status.nextWaveGaps).toContain(
      'Do not add Alembic projects API consumption to Plugin; handoff remains read-only and uses resident service scope plus runtime-control state.'
    );
  });
});
