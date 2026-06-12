/**
 * Regression test for certification F-V2-3 (matrix v2, 2026-06-13).
 *
 * Under plugin-shell launches the runtime is spawned with cwd = the plugin
 * install dir (deliberate: relative entrypoints die when hosts spawn from the
 * session cwd). PanoramaModule used to resolve its project root as
 * `config.projectRoot ?? process.cwd()` — a config field the MCP path never
 * sets — so the whole panorama chain (scanner, discoverer, refiner,
 * dimension analyzer) bound the SHELL tree while the knowledge repositories
 * stayed on the real project workspace. The language/dimension mismatch then
 * crashed Core's DimensionAnalyzer with a raw "Cannot read properties of
 * undefined (reading 'count')" on the wire for bare alembic_panorama calls.
 *
 * This pins the wiring: every panorama component must receive the container
 * project root (`singletons._projectRoot`), not process.cwd(), when the
 * container was initialized with an explicit root.
 */
import { describe, expect, it } from 'vitest';
import { PanoramaModule } from '../../lib/injection/modules/PanoramaModule.js';

const CONTAINER_ROOT = '/fake/real-project-root';

function makeRecordingContainer() {
  const factories = new Map<string, (c: unknown) => unknown>();
  const recorded: { entityCountRoots: string[] } = { entityCountRoots: [] };
  const stubEntityRepo = {
    // PanoramaScanner.ensureData probes entity count first; recording the
    // projectRoot it is asked about observes the bound root without running
    // a real scan (count > 0 short-circuits the built-in scan).
    async getEntityCount(projectRoot: string) {
      recorded.entityCountRoots.push(projectRoot);
      return 1;
    },
    async findDistinctFilePaths() {
      return [];
    },
  };
  const stubs: Record<string, unknown> = {
    bootstrapRepository: { async getLatestPrimaryLang() { return null; } },
    codeEntityRepository: stubEntityRepo,
    knowledgeEdgeRepository: {},
    knowledgeRepository: {},
  };
  const container = {
    // Mirrors the MCP plugin path: initialize() sets _projectRoot, while the
    // bootstrap `config` object carries no projectRoot field.
    singletons: { _projectRoot: CONTAINER_ROOT } as Record<string, unknown>,
    config: {} as { projectRoot?: string },
    singleton(name: string, factory: (c: unknown) => unknown) {
      factories.set(name, factory);
    },
    get(name: string) {
      const factory = factories.get(name);
      if (factory) {
        return factory(container);
      }
      if (name in stubs) {
        return stubs[name];
      }
      throw new Error(`unexpected dependency: ${name}`);
    },
  };
  return { container, recorded };
}

describe('PanoramaModule project-root wiring (F-V2-3 regression)', () => {
  it('binds the container project root, not process.cwd(), for the scanner chain', async () => {
    const { container, recorded } = makeRecordingContainer();
    PanoramaModule.register(container as never);

    const scanner = container.get('panoramaScanner') as {
      ensureData(): Promise<unknown>;
    };
    await scanner.ensureData();

    expect(recorded.entityCountRoots.length).toBeGreaterThan(0);
    for (const root of recorded.entityCountRoots) {
      expect(root).toBe(CONTAINER_ROOT);
      expect(root).not.toBe(process.cwd());
    }
  });

  it('keeps an explicit config.projectRoot as the highest-priority source', () => {
    const { container, recorded } = makeRecordingContainer();
    container.config.projectRoot = '/fake/config-override-root';
    PanoramaModule.register(container as never);

    const scanner = container.get('panoramaScanner') as {
      ensureData(): Promise<unknown>;
    };
    return scanner.ensureData().then(() => {
      expect(recorded.entityCountRoots[0]).toBe('/fake/config-override-root');
    });
  });
});
