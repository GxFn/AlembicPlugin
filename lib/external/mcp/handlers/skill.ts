/**
 * MCP Handlers — Skills 加载与发现
 *
 * 为 MCP 外部 Agent 提供 Skills 访问能力，使其能按需获取领域操作指南。
 * Skills 是 Agent 的知识增强文档，指导如何正确使用 Alembic 工具。
 *
 * 设计原则：
 *   - Skills 是只读文档，不涉及 AI 调用，不需要 Gateway gating
 *   - 外部 Agent 应根据当前任务类型选择加载合适的 Skill
 *   - list_skills 返回摘要帮助 Agent 判断该加载哪个 Skill
 */

import fs from 'node:fs';
import path from 'node:path';
import { getProjectSkillsPath } from '@alembic/core/config';
import { pathGuard, type WriteZone } from '@alembic/core/io';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import {
  buildPluginProjectSkillDeliveryReceipt,
  exportProjectSkillReceiptToCodexRuntime,
  findProjectSkillDeliveryReceipt,
  getCodexProjectSkillRoot,
  listProjectSkillDeliveryReceipts,
  validateReceiptForRuntimeExport,
} from '#codex/ProjectSkillDelivery.js';
import { CODEX_HOST_AGENT_SOURCE } from '#codex/SourceBoundary.js';
import { INJECTABLE_SKILLS_DIR } from '#shared/package-assets.js';
import type { McpContext } from './types.js';

function _getWriteZone(ctx?: McpContext | null): WriteZone | undefined {
  return ctx?.container?.singletons?.writeZone as WriteZone | undefined;
}

/**
 * 获取项目级 Skills 目录（运行时动态解析）
 * Ghost 模式下指向外置工作区: ~/.asd/workspaces/<id>/Alembic/skills/
 * 标准模式: {projectRoot}/Alembic/skills/
 */
function _getProjectSkillsDir(ctx?: McpContext) {
  return getProjectSkillsPath(resolveDataRoot(ctx?.container));
}

/**
 * 解析 SKILL.md frontmatter 全部元数据
 *
 * 返回 { description, createdBy, createdAt }，缺失字段为 null。
 * 同时兼容旧格式（无 createdBy 的 SKILL.md）。
 */
function _parseSkillMeta(skillName: string, baseDir = INJECTABLE_SKILLS_DIR) {
  try {
    const content = fs.readFileSync(path.join(baseDir, skillName, 'SKILL.md'), 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const meta: { description: string; createdBy: string | null; createdAt: string | null } = {
      description: skillName,
      createdBy: null,
      createdAt: null,
    };
    if (fmMatch) {
      const fm = fmMatch[1];
      const descMatch = fm.match(/^description:\s*(.+?)$/m);
      if (descMatch) {
        const desc = descMatch[1].trim();
        const firstSentence = desc.split(/\.\s/)[0];
        meta.description =
          firstSentence.length < desc.length ? `${firstSentence}.` : desc.substring(0, 120);
      }
      const cbMatch = fm.match(/^createdBy:\s*(.+?)$/m);
      if (cbMatch) {
        meta.createdBy = cbMatch[1].trim();
      }
      const caMatch = fm.match(/^createdAt:\s*(.+?)$/m);
      if (caMatch) {
        meta.createdAt = caMatch[1].trim();
      }
    }
    return meta;
  } catch {
    return { description: skillName, createdBy: null, createdAt: null };
  }
}

/** Skill 适用场景映射 — 帮助 Agent 判断何时该加载哪个 Skill */
const SKILL_USE_CASES: Record<string, string> = {
  'alembic-create': '将代码模式/规则/事实提交到知识库',
  'alembic-guard': '代码规范审计（Guard 规则检查）',
  'alembic-recipes': '查询/使用项目标准（Recipe 上下文检索）',
  'alembic-structure': '了解项目结构（Target / 依赖图谱 / 知识图谱）',
};

// ═══════════════════════════════════════════════════════════
// Handler: listSkills
// ═══════════════════════════════════════════════════════════

/**
 * 列出所有可用 Skills 及其摘要描述
 *
 * @returns JSON envelope
 */
export function listSkills(ctx?: McpContext | null) {
  try {
    const skillMap = new Map();

    // 内置 Skills
    const builtinDirs = fs
      .readdirSync(INJECTABLE_SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const name of builtinDirs) {
      const meta = _parseSkillMeta(name, INJECTABLE_SKILLS_DIR);
      skillMap.set(name, {
        name,
        source: 'builtin',
        summary: meta.description,
        createdBy: null,
        createdAt: null,
        useCase: SKILL_USE_CASES[name] || null,
      });
    }

    // 项目级 Skills（覆盖同名内置）
    try {
      const projectSkillsDir = _getProjectSkillsDir(ctx ?? undefined);
      const projectDirs = fs
        .readdirSync(projectSkillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const name of projectDirs) {
        const meta = _parseSkillMeta(name, projectSkillsDir);
        skillMap.set(name, {
          name,
          source: 'project',
          summary: meta.description,
          createdBy: meta.createdBy,
          createdAt: meta.createdAt,
          useCase: SKILL_USE_CASES[name] || null,
        });
      }
    } catch {
      /* no project skills */
    }

    const skills = [...skillMap.values()].sort((a, b) => a.name.localeCompare(b.name));

    return JSON.stringify({
      success: true,
      data: {
        skills,
        total: skills.length,
        hint: '根据当前任务选择合适的 Skill 加载（load_skill）。',
      },
    });
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'SKILLS_READ_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════
// Handler: loadSkill
// ═══════════════════════════════════════════════════════════

/**
 * 加载指定 Skill 的完整文档内容
 *
 * @param _ctx MCP context（未使用，保持签名一致）
 * @param args { skillName: string, section?: string }
 * @returns JSON envelope
 */
export function loadSkill(ctx: McpContext | null, args: { skillName?: string; section?: string }) {
  const { skillName, section } = args || {};

  if (!skillName) {
    return JSON.stringify({
      success: false,
      error: { code: 'MISSING_PARAM', message: 'skillName is required' },
    });
  }

  // 项目级 Skills 优先
  const projectSkillsDir = _getProjectSkillsDir(ctx ?? undefined);
  const projectSkillPath = path.join(projectSkillsDir, skillName, 'SKILL.md');
  const builtinSkillPath = path.join(INJECTABLE_SKILLS_DIR, skillName, 'SKILL.md');
  const skillPath = fs.existsSync(projectSkillPath) ? projectSkillPath : builtinSkillPath;
  const source = skillPath === projectSkillPath ? 'project' : 'builtin';

  try {
    let content = fs.readFileSync(skillPath, 'utf8');

    // 如果指定了 section，只返回对应章节
    if (section) {
      const sectionRe = new RegExp(
        `^##\\s+.*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$\\n([\\s\\S]*?)(?=^##\\s|$)`,
        'mi'
      );
      const match = content.match(sectionRe);
      if (match) {
        content = match[0];
      }
    }

    // 提取 createdBy/createdAt
    const meta = _parseSkillMeta(
      skillName,
      source === 'project' ? projectSkillsDir : INJECTABLE_SKILLS_DIR
    );

    // ── SkillHooks: onSkillLoad (fire-and-forget) ──
    try {
      const skillHooks = ctx?.container?.get?.('skillHooks');
      if (skillHooks?.has?.('onSkillLoad')) {
        skillHooks.run('onSkillLoad', { skillName, source }).catch(() => {
          /* fire-and-forget */
        });
      }
    } catch {
      /* skillHooks not available */
    }

    return JSON.stringify({
      success: true,
      data: {
        skillName,
        source,
        content,
        charCount: content.length,
        createdBy: source === 'project' ? meta.createdBy : null,
        createdAt: source === 'project' ? meta.createdAt : null,
        useCase: SKILL_USE_CASES[skillName] || null,
        relatedSkills: _getRelatedSkills(skillName),
      },
    });
  } catch {
    // 列出所有可用 Skills
    const available = new Set();
    try {
      fs.readdirSync(INJECTABLE_SKILLS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .forEach((d) => {
          available.add(d.name);
        });
    } catch {
      /* skip: INJECTABLE_SKILLS_DIR may not exist */
    }
    try {
      fs.readdirSync(_getProjectSkillsDir(ctx ?? undefined), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .forEach((d) => {
          available.add(d.name);
        });
    } catch {
      /* skip: project skills dir may not exist */
    }

    return JSON.stringify({
      success: false,
      error: {
        code: 'SKILL_NOT_FOUND',
        message: `Skill "${skillName}" not found`,
        availableSkills: [...available],
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════
// Handler: createSkill
// ═══════════════════════════════════════════════════════════

/**
 * 创建项目级 Skill — 写入 Alembic 数据根目录的 skills/<name>/SKILL.md
 *
 * @param _ctx MCP context
 * @param args { name, description, content, overwrite? }
 * @returns JSON envelope
 */
interface CreateSkillArgs {
  name?: string;
  description?: string;
  content?: string;
  overwrite?: boolean;
  createdBy?: string;
  title?: string;
}

interface ProjectSkillArgs extends CreateSkillArgs, UpdateSkillArgs {
  authorizeProjectSkillExport?: boolean;
  receipt?: unknown;
  receiptId?: string;
  section?: string;
  skillName?: string;
}

export function createSkill(ctx: McpContext | null, args: CreateSkillArgs) {
  const {
    name,
    description,
    content,
    overwrite = false,
    createdBy = 'external-ai',
    title,
  } = args || {};

  // ── 参数校验 ──
  if (!name || !description || !content) {
    return JSON.stringify({
      success: false,
      error: { code: 'MISSING_PARAM', message: 'name, description, content are all required' },
    });
  }

  // 名称格式校验：kebab-case（允许字母、数字、连字符）
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name) || name.length < 3 || name.length > 64) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'INVALID_NAME',
        message: `Skill name must be kebab-case (a-z, 0-9, -), 3-64 chars. Got: "${name}"`,
      },
    });
  }

  // 不允许覆盖内置 Skill
  const builtinSkillPath = path.join(INJECTABLE_SKILLS_DIR, name, 'SKILL.md');
  if (fs.existsSync(builtinSkillPath)) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'BUILTIN_CONFLICT',
        message: `"${name}" is a built-in Skill and cannot be overwritten. Choose a different name.`,
      },
    });
  }

  // 检查同名项目级 Skill
  const projectSkillsDir = _getProjectSkillsDir(ctx ?? undefined);
  const skillDir = path.join(projectSkillsDir, name);
  const skillPath = path.join(skillDir, 'SKILL.md');
  const existedBefore = fs.existsSync(skillPath);
  if (existedBefore && !overwrite) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'ALREADY_EXISTS',
        message: `Project skill "${name}" already exists. Set overwrite=true to replace.`,
      },
    });
  }

  // ── 写入 SKILL.md ──
  let writtenSkillPath = skillPath;
  try {
    const wz = _getWriteZone(ctx);

    // 自动推断 title: 优先使用传入参数，否则从 content 的第一个 # heading 提取
    const resolvedTitle =
      title ||
      (() => {
        const m = (content || '').match(/^#\s+(.+)/m);
        return m ? m[1].trim() : '';
      })();

    const fmLines = ['---', `name: ${name}`];
    if (resolvedTitle) {
      fmLines.push(`title: "${resolvedTitle.replace(/"/g, '\\"')}"`);
    }
    fmLines.push(
      `description: ${description}`,
      `createdBy: ${createdBy}`,
      `createdAt: ${new Date().toISOString()}`,
      '---',
      ''
    );
    const frontmatter = fmLines.join('\n');

    if (wz) {
      const dataRelSkillDir = skillDir.replace(wz.dataRoot, '').replace(/^\//, '');
      const dataRelSkillPath = skillPath.replace(wz.dataRoot, '').replace(/^\//, '');
      const writeTarget = wz.data(dataRelSkillPath);
      wz.ensureDir(wz.data(dataRelSkillDir));
      wz.writeFile(writeTarget, frontmatter + content);
      writtenSkillPath = writeTarget.absolute;
    } else {
      pathGuard.assertProjectWriteSafe(skillDir);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillPath, frontmatter + content, 'utf8');
    }
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to write SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }

  // ── SkillHooks: onSkillCreated (fire-and-forget) ──
  try {
    const skillHooks = ctx?.container?.get?.('skillHooks');
    if (skillHooks?.has?.('onSkillCreated')) {
      skillHooks
        .run('onSkillCreated', { name, description, createdBy, path: writtenSkillPath })
        .catch(() => {
          /* fire-and-forget */
        });
    }
  } catch {
    /* skillHooks not available */
  }

  return JSON.stringify({
    success: true,
    data: {
      skillName: name,
      path: writtenSkillPath,
      overwritten: existedBefore && overwrite,
      hint: `Skill "${name}" created in Alembic storage. Use alembic_project_skill({ operation: "export", name: "${name}", authorizeProjectSkillExport: true }) to make it visible to Codex runtime.`,
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: deleteSkill
// ═══════════════════════════════════════════════════════════

/**
 * 删除项目级 Skill — 移除 {projectRoot}/Alembic/skills/<name>/ 整个目录
 * 内置 Skill 不可删除。
 *
 * @param _ctx MCP context
 * @param args { name: string }
 * @returns JSON envelope
 */
export function deleteSkill(ctx: McpContext | null, args: { name?: string }) {
  const { name } = args || {};

  if (!name) {
    return JSON.stringify({
      success: false,
      error: { code: 'MISSING_PARAM', message: 'name is required' },
    });
  }

  // 不允许删除内置 Skill
  const builtinSkillPath = path.join(INJECTABLE_SKILLS_DIR, name);
  if (fs.existsSync(builtinSkillPath)) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'BUILTIN_PROTECTED',
        message: `"${name}" is a built-in Skill and cannot be deleted.`,
      },
    });
  }

  // 检查项目级 Skill 是否存在
  const projectSkillsDir = _getProjectSkillsDir(ctx ?? undefined);
  const skillDir = path.join(projectSkillsDir, name);
  if (!fs.existsSync(skillDir)) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'SKILL_NOT_FOUND',
        message: `Project skill "${name}" not found.`,
      },
    });
  }

  // ── 删除目录 ──
  try {
    const wz = _getWriteZone(ctx);
    if (wz) {
      const dataRel = skillDir.replace(wz.dataRoot, '').replace(/^\//, '');
      wz.remove(wz.data(dataRel), { recursive: true });
    } else {
      pathGuard.assertProjectWriteSafe(skillDir);
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'DELETE_ERROR',
        message: `Failed to delete skill: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }

  // ── SkillHooks: onSkillExpired (fire-and-forget) ──
  try {
    const skillHooks = ctx?.container?.get?.('skillHooks');
    if (skillHooks?.has?.('onSkillExpired')) {
      skillHooks.run('onSkillExpired', { name, reason: 'deleted' }).catch(() => {
        /* fire-and-forget */
      });
    }
  } catch {
    /* skillHooks not available */
  }

  return JSON.stringify({
    success: true,
    data: {
      skillName: name,
      deleted: true,
      hint: `Skill "${name}" deleted successfully.`,
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: updateSkill
// ═══════════════════════════════════════════════════════════

/**
 * 更新项目级 Skill — 修改 description 和/或 content
 * 内置 Skill 不可更新。
 *
 * @param _ctx MCP context
 * @param args { name, description?, content? }
 * @returns JSON envelope
 */
interface UpdateSkillArgs {
  name?: string;
  description?: string;
  content?: string;
}

export function updateSkill(ctx: McpContext | null, args: UpdateSkillArgs) {
  const { name, description, content } = args || {};

  if (!name) {
    return JSON.stringify({
      success: false,
      error: { code: 'MISSING_PARAM', message: 'name is required' },
    });
  }

  if (!description && !content) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'NOTHING_TO_UPDATE',
        message: 'At least one of description or content must be provided.',
      },
    });
  }

  // 不允许更新内置 Skill
  const builtinSkillPath = path.join(INJECTABLE_SKILLS_DIR, name, 'SKILL.md');
  if (fs.existsSync(builtinSkillPath)) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'BUILTIN_PROTECTED',
        message: `"${name}" is a built-in Skill and cannot be updated. Fork it as a project skill instead.`,
      },
    });
  }

  // 检查项目级 Skill 是否存在
  const projectSkillsDir = _getProjectSkillsDir(ctx ?? undefined);
  const skillPath = path.join(projectSkillsDir, name, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'SKILL_NOT_FOUND',
        message: `Project skill "${name}" not found. Use alembic_project_skill({ operation: "create" }) to create it first.`,
      },
    });
  }

  try {
    // ── 读取现有文件 ──
    const existing = fs.readFileSync(skillPath, 'utf8');

    // 解析现有 frontmatter
    const fmMatch = existing.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    let oldFm = '';
    let oldBody = existing;
    if (fmMatch) {
      oldFm = fmMatch[1];
      oldBody = fmMatch[2];
    }

    // 解析已有字段
    const getField = (fm: string, key: string) => {
      const m = fm.match(new RegExp(`^${key}:\\s*(.+?)$`, 'm'));
      return m ? m[1].trim() : null;
    };

    const newDesc = description || getField(oldFm, 'description') || name;
    const newBody = content !== undefined && content !== null ? content : oldBody;

    // 保留原有字段
    const createdBy = getField(oldFm, 'createdBy') || 'external-ai';
    const createdAt = getField(oldFm, 'createdAt') || new Date().toISOString();
    const title = getField(oldFm, 'title');

    // 重建 frontmatter
    const fmLines = ['---', `name: ${name}`];
    if (title) {
      fmLines.push(`title: ${title}`);
    }
    fmLines.push(
      `description: ${newDesc}`,
      `createdBy: ${createdBy}`,
      `createdAt: ${createdAt}`,
      `updatedAt: ${new Date().toISOString()}`,
      '---',
      ''
    );

    const wz = _getWriteZone(ctx);
    const fileContent = fmLines.join('\n') + newBody;
    if (wz) {
      const dataRel = skillPath.replace(wz.dataRoot, '').replace(/^\//, '');
      wz.writeFile(wz.data(dataRel), fileContent);
    } else {
      pathGuard.assertProjectWriteSafe(path.join(projectSkillsDir, name));
      fs.writeFileSync(skillPath, fileContent, 'utf8');
    }
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'UPDATE_ERROR',
        message: `Failed to update skill: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }

  return JSON.stringify({
    success: true,
    data: {
      skillName: name,
      updated: true,
      fieldsUpdated: [description ? 'description' : null, content ? 'content' : null].filter(
        Boolean
      ),
      hint: `Skill "${name}" updated in Alembic storage. Use alembic_project_skill({ operation: "export", name: "${name}", authorizeProjectSkillExport: true }) to refresh Codex runtime visibility.`,
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: projectSkill
// ═══════════════════════════════════════════════════════════

/**
 * Codex-facing Project Skill delivery handler.
 *
 * `alembic_skill` remains a compatibility alias for old Alembic storage reads/writes.
 * New Codex runtime visibility goes through this handler so receipt, authorization,
 * managed marker, and `.agents/skills` export status stay explicit.
 */
export function projectSkill(
  ctx: McpContext | null,
  args: ProjectSkillArgs & { operation?: string }
) {
  const operation = args.operation || 'list';
  switch (operation) {
    case 'list':
      return listProjectSkillsForCodex(ctx);
    case 'load':
      return loadProjectSkillForCodex(ctx, args);
    case 'export':
      return exportProjectSkillForCodex(ctx, args);
    case 'create':
      return createProjectSkillForCodex(ctx, args);
    case 'update':
      return updateProjectSkillForCodex(ctx, args);
    case 'delete':
      return deleteSkill(ctx, args);
    default:
      return {
        success: false,
        errorCode: 'UNKNOWN_PROJECT_SKILL_OPERATION',
        message:
          'Unknown project skill operation. Expected: list, load, export, create, update, delete.',
        data: { operation },
      };
  }
}

function listProjectSkillsForCodex(ctx: McpContext | null) {
  const legacy = parseLegacySkillResponse(listSkills(ctx));
  const projectRoot = resolveProjectRoot(ctx?.container as never);
  const runtimeRoot = getCodexProjectSkillRoot(projectRoot);
  const runtimeExports = listRuntimeProjectSkills(runtimeRoot);
  const deliveryReceipts = listProjectSkillDeliveryReceipts(ctx).map((receipt) => ({
    id: receipt.id,
    route: receipt.route,
    skillName: receipt.skillName,
    runtimeExport: receipt.runtimeExport,
    authorization: receipt.authorization,
    conflictStatus: receipt.conflictStatus,
    shoutSummary: receipt.shoutSummary,
  }));
  const legacyData = legacy?.data as { skills?: unknown[]; total?: number } | undefined;
  return {
    success: true,
    data: {
      skills: legacyData?.skills ?? [],
      total: legacyData?.total ?? 0,
      codexRuntime: {
        root: runtimeRoot,
        exports: runtimeExports,
        total: runtimeExports.length,
      },
      deliveryReceipts,
      receiptTotal: deliveryReceipts.length,
      replacementFor: 'alembic_skill',
      hint: 'Use alembic_project_skill export/create/update for Codex runtime delivery; alembic_skill is legacy storage compatibility.',
    },
  };
}

function loadProjectSkillForCodex(ctx: McpContext | null, args: ProjectSkillArgs) {
  const name = args.skillName || args.name;
  if (!name) {
    return {
      success: false,
      errorCode: 'MISSING_PARAM',
      message: 'name is required for load.',
    };
  }

  const projectRoot = resolveProjectRoot(ctx?.container as never);
  const runtimeSkillPath = path.join(getCodexProjectSkillRoot(projectRoot), name, 'SKILL.md');
  if (fs.existsSync(runtimeSkillPath)) {
    let content = fs.readFileSync(runtimeSkillPath, 'utf8');
    if (args.section) {
      content = extractSection(content, args.section);
    }
    return {
      success: true,
      data: {
        skillName: name,
        source: 'codex-runtime',
        path: runtimeSkillPath,
        content,
        charCount: content.length,
        hint: 'Loaded from Codex project runtime export.',
      },
    };
  }

  return parseLegacySkillResponse(loadSkill(ctx, { skillName: name, section: args.section }));
}

function exportProjectSkillForCodex(ctx: McpContext | null, args: ProjectSkillArgs) {
  const receipt = findProjectSkillDeliveryReceipt(ctx, {
    name: args.name,
    receipt: args.receipt,
    receiptId: args.receiptId,
    skillName: args.skillName,
  });
  if (!receipt) {
    return {
      success: false,
      errorCode: 'PROJECT_SKILL_RECEIPT_NOT_FOUND',
      message:
        'ProjectSkillDeliveryReceipt was not provided and no matching receipt was found in workflow reports.',
      data: { name: args.name || args.skillName || null, receiptId: args.receiptId || null },
    };
  }

  const validation = validateReceiptForRuntimeExport(receipt);
  if (!validation.ok) {
    return {
      success: false,
      errorCode: 'PROJECT_SKILL_RECEIPT_INVALID',
      message: 'ProjectSkillDeliveryReceipt failed validation; runtime export is blocked.',
      data: validation,
    };
  }

  const result = exportProjectSkillReceiptToCodexRuntime(ctx, {
    receipt,
    authorize: args.authorizeProjectSkillExport === true,
    grantedBy: CODEX_HOST_AGENT_SOURCE,
    overwriteManaged: args.overwrite !== false,
  });
  return {
    success: result.runtimeExportStatus === 'exported',
    errorCode: result.runtimeExportStatus === 'exported' ? null : 'PROJECT_SKILL_EXPORT_BLOCKED',
    message: result.receipt.runtimeExport.message || result.receipt.shoutSummary.message,
    data: {
      authorizationStatus: result.authorizationStatus,
      conflictStatus: result.conflictStatus,
      receipt: result.receipt,
      runtimeExportStatus: result.runtimeExportStatus,
      targetPath: result.targetPath,
    },
  };
}

function createProjectSkillForCodex(ctx: McpContext | null, args: ProjectSkillArgs) {
  const created = parseLegacySkillResponse(createSkill(ctx, args));
  if (!created?.success) {
    return created;
  }
  return attachPluginReceiptAndMaybeExport(ctx, args, created);
}

function updateProjectSkillForCodex(ctx: McpContext | null, args: ProjectSkillArgs) {
  const updated = parseLegacySkillResponse(updateSkill(ctx, args));
  if (!updated?.success) {
    return updated;
  }
  return attachPluginReceiptAndMaybeExport(ctx, args, updated);
}

function attachPluginReceiptAndMaybeExport(
  ctx: McpContext | null,
  args: ProjectSkillArgs,
  base: Record<string, unknown>
) {
  const skillName = args.skillName || args.name;
  if (!skillName) {
    return base;
  }
  const projectSkillsDir = _getProjectSkillsDir(ctx ?? undefined);
  const baseData = base.data as Record<string, unknown> | undefined;
  const sourcePath =
    typeof baseData?.path === 'string'
      ? baseData.path
      : path.join(projectSkillsDir, skillName, 'SKILL.md');
  const receipt = buildPluginProjectSkillDeliveryReceipt(ctx, {
    skillName,
    description: args.description ?? null,
    sourcePath,
    evidenceRefs: [{ kind: 'skill-file', ref: sourcePath }],
  });
  const exportResult =
    args.authorizeProjectSkillExport === true
      ? exportProjectSkillReceiptToCodexRuntime(ctx, {
          receipt,
          authorize: true,
          grantedBy: CODEX_HOST_AGENT_SOURCE,
          overwriteManaged: args.overwrite !== false,
        })
      : null;

  return {
    ...base,
    data: {
      ...((base.data as Record<string, unknown> | undefined) ?? {}),
      deliveryReceipt: exportResult?.receipt ?? receipt,
      runtimeExport: exportResult
        ? {
            authorizationStatus: exportResult.authorizationStatus,
            conflictStatus: exportResult.conflictStatus,
            status: exportResult.runtimeExportStatus,
            targetPath: exportResult.targetPath,
          }
        : receipt.runtimeExport,
      replacementFor: 'alembic_skill',
    },
    message:
      exportResult?.receipt.shoutSummary.message ??
      `Project Skill "${skillName}" stored with a Plugin route delivery receipt.`,
  };
}

function listRuntimeProjectSkills(runtimeRoot: string) {
  try {
    return fs
      .readdirSync(runtimeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const skillDir = path.join(runtimeRoot, entry.name);
        const skillPath = path.join(skillDir, 'SKILL.md');
        const markerPath = path.join(skillDir, '.alembic-managed.json');
        return {
          name: entry.name,
          path: skillDir,
          skillPath,
          visible: fs.existsSync(skillPath),
          managed: fs.existsSync(markerPath),
        };
      });
  } catch {
    return [];
  }
}

function parseLegacySkillResponse(
  value: string | Record<string, unknown>
): Record<string, unknown> {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {
      success: false,
      errorCode: 'LEGACY_SKILL_RESPONSE_PARSE_FAILED',
      message: value,
    };
  }
}

function extractSection(content: string, section: string) {
  const sectionRe = new RegExp(
    `^##\\s+.*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$\\n([\\s\\S]*?)(?=^##\\s|$)`,
    'mi'
  );
  const match = content.match(sectionRe);
  return match ? match[0] : content;
}

/** 相关 Skills（基于静态映射） */
function _getRelatedSkills(skillName: string) {
  const relations = {
    'alembic-create': ['alembic-recipes'],
    'alembic-guard': ['alembic-recipes'],
    'alembic-recipes': ['alembic-guard', 'alembic-structure', 'alembic-create'],
    'alembic-structure': ['alembic-recipes', 'alembic-create'],
  };
  return (relations as Record<string, string[]>)[skillName] || [];
}
