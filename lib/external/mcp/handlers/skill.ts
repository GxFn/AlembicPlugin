/**
 * MCP Handlers — Codex Project Skill service facade.
 *
 * AP-KS-1 后，skill 写入面统一交给 ProjectSkillService：
 * - source: dataRoot/Alembic/skills/<name>/
 * - runtime: projectRoot/.agents/skills/<name>/SKILL.md symlink
 * - same-name project skill 覆盖内建 skill 是目标能力，不再是 built-in conflict。
 *
 * 本 handler 只做 MCP/HTTP 兼容转接，不接 SkillHooks，也不改 tool visibility/gate。
 */

import {
  createProjectSkillService,
  type ProjectSkillServiceInput,
} from '#service/skills/ProjectSkillService.js';
import type { McpContext } from './types.js';

interface CreateSkillArgs {
  content?: string;
  createdBy?: string;
  description?: string;
  name?: string;
  overwrite?: boolean;
  title?: string;
}

interface UpdateSkillArgs {
  content?: string;
  description?: string;
  name?: string;
}

interface ProjectSkillArgs extends CreateSkillArgs, UpdateSkillArgs {
  authorizeProjectSkillExport?: boolean;
  operation?: string;
  receipt?: unknown;
  receiptId?: string;
  section?: string;
  skillName?: string;
}

export function listSkills(ctx?: McpContext | null) {
  return JSON.stringify(createProjectSkillService(ctx ?? null).list());
}

export function loadSkill(ctx: McpContext | null, args: { skillName?: string; section?: string }) {
  return JSON.stringify(
    createProjectSkillService(ctx).load({ name: args.skillName, section: args.section })
  );
}

export function createSkill(ctx: McpContext | null, args: CreateSkillArgs) {
  return JSON.stringify(createProjectSkillService(ctx).upsert(args));
}

export function updateSkill(ctx: McpContext | null, args: UpdateSkillArgs) {
  if (!args?.description && !args?.content) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'NOTHING_TO_UPDATE',
        message: 'At least one of description or content must be provided.',
      },
    });
  }
  return JSON.stringify(createProjectSkillService(ctx).upsert({ ...args, overwrite: true }));
}

export function deleteSkill(ctx: McpContext | null, args: { name?: string }) {
  return JSON.stringify(createProjectSkillService(ctx).delete(args));
}

export function projectSkill(ctx: McpContext | null, args: ProjectSkillArgs) {
  const service = createProjectSkillService(ctx);
  const operation = args.operation || 'list';
  const normalizedArgs: ProjectSkillServiceInput = args.name
    ? args
    : { ...args, name: args.skillName };

  switch (operation) {
    case 'list':
      return service.list();
    case 'load':
      return service.load(normalizedArgs);
    case 'export':
      return service.export(normalizedArgs);
    case 'create':
    case 'update':
    case 'upsert':
      return service.upsert({
        ...normalizedArgs,
        overwrite: operation === 'create' ? args.overwrite : true,
      });
    case 'delete':
      return service.delete(normalizedArgs);
    case 'refresh':
      return service.refreshKnowledgeSkills(normalizedArgs);
    default:
      return {
        success: false,
        errorCode: 'UNKNOWN_PROJECT_SKILL_OPERATION',
        message:
          'Unknown project skill operation. Expected: list, load, export, create, update, upsert, delete, refresh.',
        data: { operation },
      };
  }
}
