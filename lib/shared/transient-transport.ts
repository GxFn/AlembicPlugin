import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceResolver } from '@alembic/core/workspace';

export interface TransientTransportRef {
  bytes: number;
  path: string;
}

export interface TransientTransportLocationInput {
  dataRoot?: string;
  name: string;
  projectRoot: string;
}

export async function writeTransientTransport(
  input: TransientTransportLocationInput & { payload: unknown }
): Promise<TransientTransportRef> {
  const filePath = transientTransportPath(input);
  const content = `${JSON.stringify(input.payload, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return {
    bytes: Buffer.byteLength(content, 'utf8'),
    path: filePath,
  };
}

export async function removeTransientTransportIfPresent(
  input: TransientTransportLocationInput
): Promise<void> {
  await fs.rm(transientTransportPath(input), { force: true });
}

export function transientTransportPath(input: TransientTransportLocationInput): string {
  return path.join(
    resolveTransientTransportDataRoot(input),
    '.asd',
    'tmp',
    `${safeTransientTransportName(input.name)}-${projectHash(input.projectRoot)}.json`
  );
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function resolveTransientTransportDataRoot(input: TransientTransportLocationInput): string {
  if (input.dataRoot) {
    return input.dataRoot;
  }
  try {
    return WorkspaceResolver.fromProject(input.projectRoot).dataRoot;
  } catch {
    return input.projectRoot;
  }
}

function safeTransientTransportName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe.length > 0 ? safe : 'transport';
}

function projectHash(projectRoot: string): string {
  return createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}
