import { analyzeFile } from '@alembic/core/test-fixtures';

/** 真实项目集成测试的最小文件输入：只需要内容与相对路径。 */
export interface AstFixtureFile {
  name?: string;
  relativePath: string;
  content: string;
}

type AstFileSummary = NonNullable<ReturnType<typeof analyzeFile>>;

/**
 * Core 已移除项目级 AST 聚合（四个仓库均无生产调用方）。真实项目集成测试只需要
 * "逐文件分析后把类型、协议与模式计数加总"，在测试侧完成，不再依赖 Core 的聚合出口。
 * 无插件或解析失败的文件按 analyzeFile 的既有语义跳过，不计入 fileCount。
 */
export function summarizeAstFiles(files: readonly AstFixtureFile[], lang: string) {
  const fileSummaries: Array<AstFileSummary & { file: string }> = [];
  const patternStats: Record<string, { count: number; files: string[] }> = {};
  for (const file of files) {
    const summary = analyzeFile(file.content, lang);
    if (!summary) {
      continue;
    }
    fileSummaries.push({ file: file.relativePath, ...summary });
    for (const pattern of summary.patterns) {
      const stat = (patternStats[pattern.type] ??= { count: 0, files: [] });
      stat.count += 1;
      if (!stat.files.includes(file.relativePath)) {
        stat.files.push(file.relativePath);
      }
    }
  }
  const withFile = <T extends object>(pick: (summary: AstFileSummary) => T[]) =>
    fileSummaries.flatMap((summary) =>
      pick(summary).map((record) => ({ ...record, file: summary.file }))
    );
  return {
    lang,
    fileCount: fileSummaries.length,
    classes: withFile((summary) => summary.classes),
    protocols: withFile((summary) => summary.protocols),
    categories: withFile((summary) => summary.categories),
    patternStats,
    fileSummaries,
  };
}
