import type { ProjectSkillDeliveryReceipt } from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import { createProjectSkillService } from '#service/skills/ProjectSkillService.js';

const logger = Logger.getInstance();

interface SkillContext {
  container?: {
    singletons?: Record<string, unknown>;
    get?(name: string): unknown;
  } | null;
}

interface SkillDimensionDef {
  id: string;
  label?: string;
  skillWorthy?: boolean;
  skillMeta?: { name?: string; description?: string } | null;
}

interface SkillQualityResult {
  pass: boolean;
  reason: string | null;
  deduplicatedText?: string;
}

export interface WorkflowSkillGenerationResult {
  deliveryReceipt?: ProjectSkillDeliveryReceipt;
  error?: string;
  exportResult?: {
    authorizationStatus: ProjectSkillDeliveryReceipt['authorization']['status'];
    conflictStatus: ProjectSkillDeliveryReceipt['conflictStatus'];
    runtimeExportStatus: ProjectSkillDeliveryReceipt['runtimeExport']['status'];
    targetPath: string | null;
  };
  skillName: string;
  success: boolean;
}

const MIN_ANALYSIS_LENGTH = 100;
const HARD_REJECT_RATIO = 0.1;
const CONSECUTIVE_DUPE_THRESHOLD = 8;
const STRUCTURE_CHECK_THRESHOLD = 500;

export async function generateSkill(
  ctx: SkillContext,
  dim: SkillDimensionDef,
  analysisText: string,
  referencedFiles: string[] = [],
  keyFindings: string[] = [],
  source = 'bootstrap'
): Promise<WorkflowSkillGenerationResult> {
  const skillName = dim.skillMeta?.name || `project-${dim.id}`;
  const validation = validateSkillQuality(analysisText);
  if (!validation.pass) {
    logger.warn(`[SkillGenerator] Skill "${dim.id}" skipped — ${validation.reason}`);
    return { success: false, skillName, error: validation.reason ?? undefined };
  }

  const effectiveText = validation.deduplicatedText || analysisText;
  const skillContent = buildSkillContent(dim, effectiveText, referencedFiles, keyFindings, source);

  try {
    const skillDescription = dim.skillMeta?.description || `Auto-generated skill for ${dim.label}`;
    const result = createProjectSkillService(ctx).upsert({
      authorizeProjectSkillExport: true,
      name: skillName,
      description: skillDescription,
      content: skillContent,
      overwrite: true,
      createdBy: source,
    });

    if (result.success) {
      const deliveryReceipt = result.data?.deliveryReceipt as
        | ProjectSkillDeliveryReceipt
        | undefined;
      const runtimeExport = result.data?.runtimeExport as
        | {
            authorizationStatus?: ProjectSkillDeliveryReceipt['authorization']['status'];
            conflictStatus?: ProjectSkillDeliveryReceipt['conflictStatus'];
            status?: ProjectSkillDeliveryReceipt['runtimeExport']['status'];
            targetPath?: string | null;
          }
        | undefined;
      const runtimeExportStatus = runtimeExport?.status ?? deliveryReceipt?.runtimeExport.status;
      logger.info(`[SkillGenerator] Skill "${skillName}" created for "${dim.id}" (${source})`);
      return {
        success: runtimeExportStatus === 'exported',
        skillName,
        ...(deliveryReceipt ? { deliveryReceipt } : {}),
        exportResult: {
          authorizationStatus:
            runtimeExport?.authorizationStatus ??
            deliveryReceipt?.authorization.status ??
            'pending',
          conflictStatus:
            runtimeExport?.conflictStatus ?? deliveryReceipt?.conflictStatus ?? 'blocked',
          runtimeExportStatus: runtimeExportStatus ?? 'pending',
          targetPath:
            runtimeExport?.targetPath ?? deliveryReceipt?.runtimeExport.targetPath ?? null,
        },
        ...(runtimeExportStatus === 'exported'
          ? {}
          : { error: deliveryReceipt?.runtimeExport.message ?? 'runtime export blocked' }),
      };
    }

    const errorMsg =
      result.error?.message || result.message || 'ProjectSkillService returned failure';
    throw new Error(errorMsg);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[SkillGenerator] Skill generation failed for "${dim.id}": ${msg}`);
    return { success: false, skillName, error: msg };
  }
}

function validateSkillQuality(analysisText: string): SkillQualityResult {
  if (!analysisText || analysisText.trim().length < MIN_ANALYSIS_LENGTH) {
    return {
      pass: false,
      reason: `analysisText too short (${analysisText?.trim().length || 0} chars, min ${MIN_ANALYSIS_LENGTH})`,
    };
  }

  const textLines = analysisText.split('\n').filter((line: string) => line.trim().length > 0);
  const normalizedLines = textLines.map(normalizeLine).filter((line: string) => line.length > 0);
  const uniqueNormalized = new Set(normalizedLines);
  const uniqueRatio =
    normalizedLines.length > 0 ? uniqueNormalized.size / normalizedLines.length : 1;
  const maxConsDupes = maxConsecutiveDuplicates(normalizedLines);
  const isRepetitive =
    (normalizedLines.length > 30 && uniqueRatio < HARD_REJECT_RATIO) ||
    maxConsDupes >= CONSECUTIVE_DUPE_THRESHOLD;

  if (isRepetitive) {
    const cleaned = deduplicateConsecutive(analysisText);
    if (cleaned.trim().length >= MIN_ANALYSIS_LENGTH) {
      logger.info(
        `[SkillGenerator] Repetition detected (${uniqueNormalized.size}/${normalizedLines.length} unique, ` +
          `ratio ${uniqueRatio.toFixed(2)}, maxConsec ${maxConsDupes}), salvaged via dedup ` +
          `(${analysisText.length} -> ${cleaned.length} chars)`
      );
      return { pass: true, reason: null, deduplicatedText: cleaned };
    }
    return {
      pass: false,
      reason: `repetitive content detected (${uniqueNormalized.size}/${normalizedLines.length} unique, ratio ${uniqueRatio.toFixed(2)}, maxConsec ${maxConsDupes}) - dedup salvage also too short (${cleaned.trim().length} chars)`,
    };
  }

  const hasStructure =
    /^#{1,3}\s.+/m.test(analysisText) ||
    /^\d+\.\s/m.test(analysisText) ||
    /^[-*•]\s/m.test(analysisText) ||
    /```[\s\S]*?```/.test(analysisText) ||
    /^[-*]\s*[❌⚠✅🔴🟡🟢•]/u.test(analysisText) ||
    /\*\*[^*]+\*\*/.test(analysisText) ||
    analysisText.split(/\n\s*\n/).filter((paragraph: string) => paragraph.trim().length > 0)
      .length >= 3;
  if (!hasStructure && analysisText.length < STRUCTURE_CHECK_THRESHOLD) {
    return { pass: false, reason: 'no structured content detected' };
  }

  return { pass: true, reason: null };
}

function buildSkillContent(
  dim: SkillDimensionDef,
  analysisText: string,
  referencedFiles: string[] = [],
  keyFindings: string[] = [],
  source = 'bootstrap'
) {
  const parts: string[] = [];
  parts.push(`# ${dim.label || dim.id}`);
  parts.push('');
  parts.push(
    `> Auto-generated by Bootstrap (${source}). Sources: ${referencedFiles.length} files analyzed.`
  );
  parts.push('');

  if (keyFindings.length > 0) {
    parts.push('## 关键发现');
    parts.push('');
    for (const finding of keyFindings) {
      parts.push(`- ${finding}`);
    }
    parts.push('');
  }

  parts.push(analysisText);

  if (referencedFiles.length > 0) {
    parts.push('');
    parts.push('## Referenced Files');
    parts.push('');
    for (const file of referencedFiles.slice(0, 20)) {
      parts.push(`- \`${file}\``);
    }
  }

  return parts.filter((part) => part !== undefined).join('\n');
}

function normalizeLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*•]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/^[`>]+\s*/, '')
    .replace(/^#{1,3}\s+/, '')
    .replace(/\(来源[:：].*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function maxConsecutiveDuplicates(lines: string[]): number {
  let max = 0;
  let current = 0;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] === lines[index - 1] && lines[index].length > 0) {
      current++;
      if (current > max) {
        max = current;
      }
    } else {
      current = 0;
    }
  }
  return max;
}

function deduplicateConsecutive(text: string): string {
  const lines = text.split('\n');
  const result = [lines[0]];
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() !== lines[index - 1].trim() || lines[index].trim().length === 0) {
      result.push(lines[index]);
    }
  }
  return result.join('\n');
}
