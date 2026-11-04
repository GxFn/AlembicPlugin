import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getProjectSkillsPath } from '@alembic/core/config';
import {
  createPluginProjectSkillDeliveryReceipt,
  normalizeProjectSkillDeliveryReceipt,
  type ProjectSkillConflictStatus,
  type ProjectSkillDeliveryReceipt,
  type ProjectSkillRuntimeExportStatus,
  validateProjectSkillDeliveryReceipt,
} from '@alembic/core/host-agent-workflows';
import { pathGuard } from '@alembic/core/io';
import Logger from '@alembic/core/logging';
import { HOST_AGENT_SOURCE } from '@alembic/core/shared';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { resolveHostAdapter } from '#host-runtime/host-adapter/resolveHostAdapter.js';

export const PROJECT_SKILL_ROOT = path.join('.agents', 'skills');
export const PROJECT_SKILL_MARKER_FILE = '.alembic-managed.json';

interface ProjectSkillDeliveryContext {
  container?: {
    get?(name: string): unknown;
    singletons?: Record<string, unknown>;
  } | null;
}

export interface BuildPluginProjectSkillReceiptInput {
  contentHash?: string | null;
  description?: string | null;
  dimensionId?: string | null;
  evidenceRefs?: readonly unknown[];
  projectRoot?: string;
  skillName: string;
  sourcePath: string;
  targetName?: string | null;
}

export interface ProjectSkillRuntimeExportOptions {
  authorize?: boolean;
  grantedBy?: string;
  overwriteManaged?: boolean;
  receipt: unknown;
}

export interface ProjectSkillRuntimeExportResult {
  authorizationStatus: ProjectSkillDeliveryReceipt['authorization']['status'];
  conflictStatus: ProjectSkillConflictStatus;
  receipt: ProjectSkillDeliveryReceipt;
  runtimeExportStatus: ProjectSkillRuntimeExportStatus;
  targetPath: string | null;
}

interface RuntimeExportTargetInput {
  compatibility: { managed: boolean; sameSymlink: boolean };
  generatedSkillId: string;
  generationHash: string | null;
  hostSkillRoot: string;
  markerPath: string;
  options: ProjectSkillRuntimeExportOptions;
  projectRoot: string;
  projectScopeId: string;
  receipt: ProjectSkillDeliveryReceipt;
  sourceSkillPath: string;
  targetDir: string;
  targetSkillPath: string;
}

/**
 * Project Skill 名称规则：kebab-case，3-64 字符。
 * 名称会直接拼进 source（dataRoot/Alembic/skills）、runtime（宿主 skill root）
 * 与 builtin 目录路径，因此所有按名称寻址的操作都必须先过这条规则，
 * 防止 '..'、绝对路径或带分隔符的名称逃逸出根目录（曾导致 delete('..')
 * 递归删除整个 Alembic/ 知识目录）。
 */
const PROJECT_SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/;

export function isValidProjectSkillName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length >= 3 &&
    name.length <= 64 &&
    PROJECT_SKILL_NAME_PATTERN.test(name)
  );
}

/**
 * 纵深防御：skill 目录必须严格位于根目录之内（不能等于根目录、不能在根目录之外）。
 * 名称校验已经排除了逃逸，这里在真正触碰文件系统前再按解析后的路径复核一次。
 */
export function isSkillDirInsideRoot(root: string, skillDir: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(skillDir));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function getProjectSkillRoot(projectRoot: string): string {
  return resolveHostAdapter().projectSkillRoot(projectRoot);
}

export function buildContentHash(content: string | Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

export function buildProjectScopeId(projectRoot: string): string {
  return `project:${crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 12)}`;
}

export function buildGeneratedSkillId(projectScopeId: string, skillName: string): string {
  return `alembic:${projectScopeId}:${skillName}`;
}

export function buildPluginProjectSkillDeliveryReceipt(
  ctx: ProjectSkillDeliveryContext | null,
  input: BuildPluginProjectSkillReceiptInput
): ProjectSkillDeliveryReceipt {
  // receipt 会把 skillName 写进 markerPath / targetPath；非法名称属于调用方编程错误，直接拒绝。
  if (!isValidProjectSkillName(input.skillName)) {
    throw new Error(
      `Invalid Project Skill name for delivery receipt: ${JSON.stringify(input.skillName)}`
    );
  }
  const projectRoot = input.projectRoot ?? resolveProjectRoot(ctx?.container as never);
  const projectScopeId = buildProjectScopeId(projectRoot);
  const hostSkillRoot = getProjectSkillRoot(projectRoot);
  const sourcePath = path.resolve(input.sourcePath);
  const markerPath = path.join(hostSkillRoot, input.skillName, PROJECT_SKILL_MARKER_FILE);
  const contentHash =
    input.contentHash ??
    (fs.existsSync(sourcePath) ? buildContentHash(fs.readFileSync(sourcePath)) : null);

  return createPluginProjectSkillDeliveryReceipt({
    id: `plugin-skill-${projectScopeId.replace(/^project:/, '')}-${input.skillName}`,
    createdAt: new Date().toISOString(),
    projectRoot,
    projectScopeId,
    codexSkillRoot: hostSkillRoot,
    projectId: projectScopeId,
    skillName: input.skillName,
    dimensionId: input.dimensionId ?? null,
    targetName: input.targetName ?? null,
    asset: {
      kind: 'skill-file',
      path: sourcePath,
      skillName: input.skillName,
      contentHash,
      description: input.description ?? null,
      dimensionId: input.dimensionId ?? null,
      targetName: input.targetName ?? null,
      artifactRefs: [{ kind: 'skill-file', ref: sourcePath }],
    },
    evidenceRefs: input.evidenceRefs ?? [],
    authorization: {
      required: true,
      status: 'pending',
      projectScopeId,
      codexSkillRoot: hostSkillRoot,
      message: 'Project skill export needs project-scoped authorization.',
    },
    runtimeExport: {
      status: 'pending',
      strategy: 'symlink-first',
      linkMode: 'none',
      projectScopeId,
      codexSkillRoot: hostSkillRoot,
      targetRoot: hostSkillRoot,
      targetPath: path.join(hostSkillRoot, input.skillName),
      refreshRequired: true,
    },
    managedMarker: {
      generatedSkillId: buildGeneratedSkillId(projectScopeId, input.skillName),
      generationHash: contentHash,
      markerPath,
      projectId: projectScopeId,
      projectRoot,
      projectScopeId,
      route: 'plugin',
      skillName: input.skillName,
      sourcePath,
    },
    shoutSummary: {
      delivered: false,
      runtimeVisible: false,
      skillName: input.skillName,
      title: 'Project Skill generated',
      trigger: input.skillName,
      message: `Project Skill ${input.skillName} generated by AlembicPlugin; host runtime export is pending.`,
    },
  });
}

export function exportProjectSkillReceiptToRuntime(
  ctx: ProjectSkillDeliveryContext | null,
  options: ProjectSkillRuntimeExportOptions
): ProjectSkillRuntimeExportResult {
  const normalized = normalizeProjectSkillDeliveryReceipt(options.receipt);
  if (!normalized) {
    throw new Error('ProjectSkillDeliveryReceipt is required for runtime export.');
  }

  const projectRoot = resolveProjectRoot(ctx?.container as never);
  if (path.resolve(normalized.projectRoot) !== path.resolve(projectRoot)) {
    return finalizeReceipt(normalized, {
      authorizationStatus: normalized.authorization.status,
      conflictStatus: 'blocked',
      linkMode: 'none',
      message: `Receipt projectRoot does not match current Codex project root: ${normalized.projectRoot}`,
      runtimeExportStatus: 'blocked',
      targetPath: null,
    });
  }

  // receipt 可能来自 MCP 入参或磁盘上的历史 receipt，skillName 不可信：
  // 先按名称规则拒绝，再确认 targetDir 严格位于宿主 skill root 内，任何写入之前就阻断。
  const hostSkillRoot = getProjectSkillRoot(projectRoot);
  const targetDir = path.join(hostSkillRoot, normalized.skillName);
  if (
    !isValidProjectSkillName(normalized.skillName) ||
    !isSkillDirInsideRoot(hostSkillRoot, targetDir)
  ) {
    Logger.getInstance().warn(
      `[ProjectSkillDelivery] runtime export blocked: invalid skillName=${JSON.stringify(normalized.skillName)} ` +
        `hostSkillRoot=${hostSkillRoot} receiptId=${normalized.id}`
    );
    return finalizeReceipt(normalized, {
      authorizationStatus: normalized.authorization.status,
      conflictStatus: 'blocked',
      linkMode: 'none',
      message:
        `Invalid Project Skill name ${JSON.stringify(normalized.skillName)}: ` +
        'must be kebab-case (a-z, 0-9, -), 3-64 chars, and stay inside the host project skill root.',
      runtimeExportStatus: 'blocked',
      targetPath: null,
    });
  }

  // receipt.asset.path 同样不可信：软链接源必须正是 <dataRoot>/Alembic/skills/<skillName>/SKILL.md，
  // 否则合法名称 + 伪造 asset.path（如 .env）会把任意项目文件挂进宿主 skill root，再被 load 读出。
  const sourceSkillsRoot = getProjectSkillsPath(resolveDataRoot(ctx?.container as never));
  const sourceCheck = confineSourceSkillPath(
    sourceSkillsRoot,
    normalized.skillName,
    resolveSourceSkillPath(normalized)
  );
  if (!sourceCheck.ok) {
    Logger.getInstance().warn(
      `[ProjectSkillDelivery] runtime export blocked: source outside project skill root ` +
        `skillName=${JSON.stringify(normalized.skillName)} assetPath=${JSON.stringify(normalized.asset.path)} ` +
        `sourceSkillsRoot=${sourceSkillsRoot} reason=${sourceCheck.reason} receiptId=${normalized.id}`
    );
    return finalizeReceipt(normalized, {
      authorizationStatus: normalized.authorization.status,
      conflictStatus: 'blocked',
      linkMode: 'none',
      message:
        `Project Skill source must be ${path.join(sourceSkillsRoot, normalized.skillName, 'SKILL.md')}; ` +
        `receipt asset path ${JSON.stringify(normalized.asset.path)} was refused (${sourceCheck.reason}).`,
      runtimeExportStatus: 'blocked',
      targetPath: null,
    });
  }

  // 校验通过后统一使用规范 source 路径作为软链接目标，不再沿用 receipt 中的原始写法。
  const sourceSkillPath = sourceCheck.sourceSkillPath;
  const projectScopeId =
    normalized.projectScopeId ||
    normalized.authorization.projectScopeId ||
    buildProjectScopeId(projectRoot);
  const targetSkillPath = path.join(targetDir, 'SKILL.md');
  const markerPath = path.join(targetDir, PROJECT_SKILL_MARKER_FILE);
  const generationHash =
    normalized.managedMarker?.generationHash ||
    normalized.asset.contentHash ||
    (fs.existsSync(sourceSkillPath) ? buildContentHash(fs.readFileSync(sourceSkillPath)) : null);
  const generatedSkillId =
    normalized.managedMarker?.generatedSkillId ??
    buildGeneratedSkillId(projectScopeId, normalized.skillName);

  if (!options.authorize && normalized.authorization.status !== 'granted') {
    return finalizeReceipt(normalized, {
      authorizationStatus: 'pending',
      conflictStatus: 'blocked',
      linkMode: 'none',
      message:
        'Project-level authorization is required before exporting this Project Skill into host runtime.',
      runtimeExportStatus: 'blocked',
      targetPath: targetDir,
    });
  }

  if (!fs.existsSync(sourceSkillPath)) {
    return finalizeReceipt(normalized, {
      authorizationStatus: 'granted',
      conflictStatus: 'blocked',
      linkMode: 'none',
      message: `Source SKILL.md does not exist: ${sourceSkillPath}`,
      runtimeExportStatus: 'failed',
      targetPath: targetDir,
    });
  }

  const compatibility = inspectExistingRuntimeTarget({
    generationHash,
    generatedSkillId,
    markerPath,
    projectScopeId,
    sourceSkillPath,
    targetDir,
    targetSkillPath,
  });
  if (!compatibility.allowed) {
    return finalizeReceipt(normalized, {
      authorizationStatus: 'granted',
      conflictStatus: compatibility.conflictStatus,
      linkMode: 'none',
      message: compatibility.message,
      runtimeExportStatus: 'blocked',
      targetPath: targetDir,
    });
  }

  try {
    writeRuntimeExportTarget({
      compatibility,
      generatedSkillId,
      generationHash,
      hostSkillRoot,
      markerPath,
      options,
      projectRoot,
      projectScopeId,
      receipt: normalized,
      sourceSkillPath,
      targetDir,
      targetSkillPath,
    });
  } catch (err: unknown) {
    return finalizeReceipt(normalized, {
      authorizationStatus: 'granted',
      conflictStatus: 'blocked',
      linkMode: 'none',
      message: `Project Skill runtime export failed: ${err instanceof Error ? err.message : String(err)}`,
      runtimeExportStatus: 'failed',
      targetPath: targetDir,
    });
  }

  return finalizeReceipt(normalized, {
    authorizationStatus: 'granted',
    conflictStatus: compatibility.conflictStatus,
    linkMode: 'symlink',
    message: `Project Skill ${normalized.skillName} exported to host project runtime.`,
    runtimeExportStatus: 'exported',
    targetPath: targetDir,
  });
}

function writeRuntimeExportTarget(input: RuntimeExportTargetInput): void {
  addProjectSkillRootWritePrefix(input.projectRoot, input.hostSkillRoot);
  pathGuard.assertSafe(input.sourceSkillPath);
  pathGuard.assertProjectWriteSafe(input.targetDir);
  pathGuard.assertProjectWriteSafe(input.targetSkillPath);
  pathGuard.assertProjectWriteSafe(input.markerPath);
  fs.mkdirSync(input.targetDir, { recursive: true });

  const existingTarget = fs.lstatSync(input.targetSkillPath, { throwIfNoEntry: false });
  if (existingTarget && !input.compatibility.sameSymlink) {
    if (input.options.overwriteManaged !== false && input.compatibility.managed) {
      fs.rmSync(input.targetSkillPath, { force: true });
    }
  }

  if (!fs.existsSync(input.targetSkillPath)) {
    fs.symlinkSync(input.sourceSkillPath, input.targetSkillPath, 'file');
  }

  const marker = {
    contractVersion: input.receipt.contractVersion,
    generatedSkillId: input.generatedSkillId,
    generationHash: input.generationHash,
    managedBy: 'alembic',
    projectId: input.receipt.projectId ?? input.projectScopeId,
    projectRoot: input.projectRoot,
    projectScopeId: input.projectScopeId,
    route: input.receipt.route,
    skillName: input.receipt.skillName,
    sourcePath: input.sourceSkillPath,
    markerPath: input.markerPath,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(input.markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

export function listProjectSkillDeliveryReceipts(
  ctx: ProjectSkillDeliveryContext | null
): ProjectSkillDeliveryReceipt[] {
  const dataRoot = resolveDataRoot(ctx?.container as never);
  const reportRoots = [
    path.join(dataRoot, '.asd', 'bootstrap-report.json'),
    path.join(dataRoot, '.asd', 'bootstrap-reports'),
  ];
  const receipts: ProjectSkillDeliveryReceipt[] = [];
  for (const reportRoot of reportRoots) {
    collectReceiptsFromPath(reportRoot, receipts);
  }
  return receipts;
}

export function findProjectSkillDeliveryReceipt(
  ctx: ProjectSkillDeliveryContext | null,
  selector: { name?: string; receipt?: unknown; receiptId?: string; skillName?: string }
): ProjectSkillDeliveryReceipt | null {
  if (selector.receipt) {
    return normalizeProjectSkillDeliveryReceipt(selector.receipt);
  }
  const name = selector.skillName || selector.name;
  const receipts = listProjectSkillDeliveryReceipts(ctx);
  return (
    receipts.find((receipt) => receipt.id === selector.receiptId) ??
    receipts.find((receipt) => (name ? receipt.skillName === name : false)) ??
    null
  );
}

function resolveSourceSkillPath(receipt: ProjectSkillDeliveryReceipt): string {
  const source = path.isAbsolute(receipt.asset.path)
    ? receipt.asset.path
    : path.resolve(receipt.projectRoot, receipt.asset.path);
  try {
    const stat = fs.statSync(source);
    return stat.isDirectory() ? path.join(source, 'SKILL.md') : source;
  } catch {
    return source.endsWith('SKILL.md') ? source : path.join(source, 'SKILL.md');
  }
}

/**
 * source 端纵深防御：receipt 解析出的 SKILL.md 必须是 <sourceSkillsRoot>/<skillName>/SKILL.md。
 * 1. 字面路径一致；不一致时仅当两者 realpath 指向同一文件才放行（兼容 /var 与 /private/var 等历史写法）；
 * 2. 文件存在时，其 realpath 必须仍落在 realpath(sourceSkillsRoot)/<skillName> 下，
 *    防止规范位置上的 SKILL.md 本身是指向根目录外的软链接。
 * 文件不存在时交给后续的 "Source SKILL.md does not exist" 分支报 failed。
 */
function confineSourceSkillPath(
  sourceSkillsRoot: string,
  skillName: string,
  resolvedSourcePath: string
): { ok: true; sourceSkillPath: string } | { ok: false; reason: string } {
  const canonical = path.join(path.resolve(sourceSkillsRoot), skillName, 'SKILL.md');
  if (!isSkillDirInsideRoot(sourceSkillsRoot, path.dirname(canonical))) {
    return { ok: false, reason: 'canonical-outside-root' };
  }
  if (path.resolve(resolvedSourcePath) !== canonical) {
    const realSource = realpathOrNull(resolvedSourcePath);
    if (!realSource || realSource !== realpathOrNull(canonical)) {
      return { ok: false, reason: 'not-canonical-source' };
    }
  }
  const realCanonical = realpathOrNull(canonical);
  if (realCanonical) {
    const realRoot = realpathOrNull(sourceSkillsRoot);
    if (
      !realRoot ||
      path.relative(realRoot, path.dirname(realCanonical)) !== skillName ||
      path.basename(realCanonical) !== 'SKILL.md'
    ) {
      return { ok: false, reason: 'source-resolves-outside-root' };
    }
  }
  return { ok: true, sourceSkillPath: canonical };
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function finalizeReceipt(
  receipt: ProjectSkillDeliveryReceipt,
  outcome: {
    authorizationStatus: ProjectSkillDeliveryReceipt['authorization']['status'];
    conflictStatus: ProjectSkillConflictStatus;
    linkMode: ProjectSkillDeliveryReceipt['runtimeExport']['linkMode'];
    message: string;
    runtimeExportStatus: ProjectSkillRuntimeExportStatus;
    targetPath: string | null;
  }
): ProjectSkillRuntimeExportResult {
  const targetRoot = outcome.targetPath
    ? path.dirname(outcome.targetPath)
    : receipt.runtimeExport.targetRoot;
  const updated = normalizeProjectSkillDeliveryReceipt({
    ...receipt,
    authorization: {
      ...receipt.authorization,
      status: outcome.authorizationStatus,
      grantedBy:
        outcome.authorizationStatus === 'granted'
          ? receipt.authorization.grantedBy || HOST_AGENT_SOURCE
          : receipt.authorization.grantedBy,
      projectScopeId: receipt.authorization.projectScopeId || receipt.projectScopeId,
      codexSkillRoot: targetRoot,
      message: outcome.message,
    },
    conflictStatus: outcome.conflictStatus,
    runtimeExport: {
      ...receipt.runtimeExport,
      authorizationStatus: outcome.authorizationStatus,
      conflictStatus: outcome.conflictStatus,
      status: outcome.runtimeExportStatus,
      linkMode: outcome.linkMode,
      strategy: 'symlink-first',
      targetPath: outcome.targetPath,
      targetRoot,
      projectScopeId: receipt.runtimeExport.projectScopeId || receipt.projectScopeId,
      codexSkillRoot: targetRoot,
      refreshRequired: outcome.runtimeExportStatus === 'exported',
      message: outcome.message,
    },
    shoutSummary: {
      ...receipt.shoutSummary,
      delivered: outcome.runtimeExportStatus === 'exported',
      runtimeVisible: outcome.runtimeExportStatus === 'exported',
      message: outcome.message,
      title:
        outcome.runtimeExportStatus === 'exported'
          ? 'Project Skill exported'
          : 'Project Skill export blocked',
    },
  });
  const finalReceipt = updated ?? receipt;
  return {
    authorizationStatus: finalReceipt.authorization.status,
    conflictStatus: finalReceipt.conflictStatus,
    receipt: finalReceipt,
    runtimeExportStatus: finalReceipt.runtimeExport.status,
    targetPath: finalReceipt.runtimeExport.targetPath,
  };
}

function inspectExistingRuntimeTarget(input: {
  generatedSkillId: string;
  generationHash: string | null;
  markerPath: string;
  projectScopeId: string;
  sourceSkillPath: string;
  targetDir: string;
  targetSkillPath: string;
}): {
  allowed: boolean;
  conflictStatus: ProjectSkillConflictStatus;
  managed: boolean;
  message: string;
  sameSymlink: boolean;
} {
  const targetDirStat = fs.lstatSync(input.targetDir, { throwIfNoEntry: false });
  if (targetDirStat && !targetDirStat.isDirectory()) {
    return {
      allowed: false,
      conflictStatus: 'different-existing',
      managed: false,
      message: `Project Skill target exists but is not a directory: ${input.targetDir}`,
      sameSymlink: false,
    };
  }

  const targetStat = fs.lstatSync(input.targetSkillPath, { throwIfNoEntry: false });
  if (!targetStat) {
    return {
      allowed: true,
      conflictStatus: 'target-missing',
      managed: false,
      message: 'Project Skill target is missing and can be exported.',
      sameSymlink: false,
    };
  }

  const marker = readManagedMarker(input.markerPath);
  const sameSymlink =
    targetStat.isSymbolicLink() &&
    path.resolve(fs.readlinkSync(input.targetSkillPath)) === path.resolve(input.sourceSkillPath);
  const markerCompatible =
    marker?.managedBy === 'alembic' &&
    marker.generatedSkillId === input.generatedSkillId &&
    marker.projectScopeId === input.projectScopeId &&
    (!input.generationHash || marker.generationHash === input.generationHash);

  if (markerCompatible || sameSymlink) {
    return {
      allowed: true,
      conflictStatus: 'compatible-existing',
      managed: markerCompatible,
      message: 'Existing Project Skill target is compatible and may be refreshed.',
      sameSymlink,
    };
  }

  return {
    allowed: false,
    conflictStatus: 'different-existing',
    managed: false,
    message:
      `Project Skill target already exists and is not managed by this receipt: ` +
      `${input.targetSkillPath}`,
    sameSymlink: false,
  };
}

function addProjectSkillRootWritePrefix(projectRoot: string, hostSkillRoot: string): void {
  const relativeRoot = path.relative(path.resolve(projectRoot), path.resolve(hostSkillRoot));
  pathGuard.addProjectWritePrefix(relativeRoot);
}

function readManagedMarker(markerPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function collectReceiptsFromPath(pathname: string, receipts: ProjectSkillDeliveryReceipt[]): void {
  if (!fs.existsSync(pathname)) {
    return;
  }
  const stat = fs.statSync(pathname);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(pathname, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.name.endsWith('.json')) {
        collectReceiptsFromPath(path.join(pathname, entry.name), receipts);
      }
    }
    return;
  }
  if (!pathname.endsWith('.json')) {
    return;
  }
  try {
    collectReceiptsFromValue(JSON.parse(fs.readFileSync(pathname, 'utf8')), receipts);
  } catch {
    /* ignore unreadable historical report */
  }
}

function collectReceiptsFromValue(value: unknown, receipts: ProjectSkillDeliveryReceipt[]): void {
  const direct = normalizeProjectSkillDeliveryReceipt(value);
  if (direct) {
    if (!receipts.some((receipt) => receipt.id === direct.id)) {
      receipts.push(direct);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReceiptsFromValue(item, receipts);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectReceiptsFromValue(item, receipts);
    }
  }
}

export function validateReceiptForRuntimeExport(receipt: unknown) {
  const validation = validateProjectSkillDeliveryReceipt(receipt);
  if (!validation.ok) {
    return validation;
  }
  const normalized = validation.receipt;
  const issues = [...validation.issues];
  if (!normalized?.projectScopeId || !normalized?.authorization.projectScopeId) {
    issues.push('authorization-scope-missing' as const);
  }
  if (!normalized?.runtimeExport.projectScopeId || !normalized?.runtimeExport.codexSkillRoot) {
    issues.push('runtime-export-scope-missing' as const);
  }
  if (issues.length > validation.issues.length) {
    return {
      ...validation,
      issues,
      ok: false,
    };
  }
  return validation;
}
