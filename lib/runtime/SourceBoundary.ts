import { HOST_AGENT_SOURCE, LEGACY_IDE_AGENT_SOURCE } from '@alembic/core/shared';

const LEGACY_HOST_AGENT_WRITE_SOURCES = new Set([
  'cursor-scan',
  'mcp',
  'mcp-external',
  LEGACY_IDE_AGENT_SOURCE,
]);

export function normalizeHostAgentWriteSource(source: unknown): string {
  const value = typeof source === 'string' ? source.trim() : '';
  if (!value || LEGACY_HOST_AGENT_WRITE_SOURCES.has(value)) {
    return HOST_AGENT_SOURCE;
  }
  return value;
}
