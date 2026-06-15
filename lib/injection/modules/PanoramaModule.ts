/**
 * PanoramaModule — retired project-information provider.
 *
 * PCI ProjectContext cleanup keeps `alembic_panorama` as a retired route, but the
 * Plugin DI container must not expose Core `service/panorama` as a hidden
 * project-information source. This module remains as a narrow tombstone for
 * older imports and intentionally registers no services.
 */

import type { ServiceContainer } from '../ServiceContainer.js';

export const PanoramaModule = {
  register(container: ServiceContainer): void {
    const logger = container.singletons.logger as
      | { info?: (message: string, meta?: Record<string, unknown>) => void }
      | undefined;
    logger?.info?.('[PanoramaModule] retired; ProjectContext is the Plugin project-info source', {
      provider: 'project-context',
    });
  },
};
