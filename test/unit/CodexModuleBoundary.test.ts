import { describe, expect, it } from 'vitest';
import { buildCodexModuleBoundaryStatus } from '../../lib/codex/ModuleBoundary.js';

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
    ]);
    expect(externalOwned).toContain('alembic-daemon-main');
    expect(externalOwned).toContain('project-registry-main');
    expect(externalOwned).toContain('job-store-main');
    expect(externalOwned).toContain('file-monitor-main');
    expect(externalOwned).toContain('internal-ai-runtime');
    expect(externalOwned).toContain('dashboard-frontend-source');
  });

  it('records Dashboard as an external source with only a retained plugin artifact', () => {
    const status = buildCodexModuleBoundaryStatus();

    expect(status.dashboard).toMatchObject({
      artifactPath: 'dashboard/dist',
      buildCommand: 'npm run build:dashboard',
      deletionAllowedThisWave: false,
      pluginRole: 'dashboard-url-handoff-and-portable-artifact-packaging',
      sourceOwner: 'AlembicDashboard',
      sourceResolver: 'scripts/local-source-paths.mjs#resolveDashboardSource',
    });
    expect(status.dashboard.sourceCandidates).toEqual([
      '../AlembicDashboard',
      'vendor/AlembicDashboard',
    ]);
  });

  it('marks embedded runtime as a Plugin adapter rather than daemon source of truth', () => {
    const status = buildCodexModuleBoundaryStatus({
      enhancementRoute: {
        embeddedRuntime: {
          artifact: './runtime.tgz',
          available: true,
          packageName: 'alembic-ai',
          route: 'embedded-plugin-runtime',
          version: '0.1.2',
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
              internalAiAvailable: null,
              jobsAvailable: null,
              jobKinds: [],
            },
            dashboardUrl: null,
            healthVersion: null,
            packageName: null,
            ready: false,
            route: null,
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
  });
});
