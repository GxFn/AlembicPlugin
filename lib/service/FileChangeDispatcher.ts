import type { FileChangeEvent, ReactiveEvolutionReport } from '@alembic/core/types';

export interface FileChangeDispatcher {
  dispatch(events: FileChangeEvent[]): Promise<ReactiveEvolutionReport>;
}
