import { HOST_AGENT_SOURCE, LEGACY_IDE_AGENT_SOURCE } from '@alembic/core/shared';

const LEGACY_EXTERNAL_HOST_SOURCES = new Set([
  'cursor-scan',
  'mcp',
  'mcp-external',
  LEGACY_IDE_AGENT_SOURCE,
]);

export { HOST_AGENT_SOURCE as CODEX_HOST_AGENT_SOURCE };

export function normalizeCodexHostAgentWriteSource(source: unknown): string {
  const value = typeof source === 'string' ? source.trim() : '';
  if (!value || LEGACY_EXTERNAL_HOST_SOURCES.has(value)) {
    return HOST_AGENT_SOURCE;
  }
  return value;
}
