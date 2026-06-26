/**
 * ModuleService — ProjectContext-backed module and scan service.
 *
 * The Plugin keeps the historical ModuleService API because HTTP/MCP callers
 * still use it, but PCI cleanup removes the old Core discoverer registry as a
 * project-information source. Project, target, module, dependency, and file
 * facts now come from `ProjectContextCapabilities.execute(...)`.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import {
  basename as _pathBasename,
  dirname as _pathDirname,
  extname as _pathExtname,
  isAbsolute as _pathIsAbsolute,
  join as _pathJoin,
  resolve as _pathResolve,
  relative,
} from 'node:path';
import { inferLang } from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import type {
  ModuleContext,
  ProjectContextEnvelope,
  ProjectContextRef,
  ProjectContextRequestKind,
  ProjectContextResult,
  ProjectMap,
  RepoContext,
} from '@alembic/core/project-context';
import { ProjectContextCapabilities } from '@alembic/core/project-context-capabilities';
import { attachHostAgentManagedBoundary } from './host-managed-boundary.js';

/** 全局排除目录 */
const SCAN_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'Pods',
  'Carthage',
  '.build',
  'DerivedData',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.gradle',
  '.idea',
  'out',
  'coverage',
  '.cache',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'Alembic',
]);

/** 源码文件扩展名 */
const SOURCE_CODE_EXTS = new Set([
  '.swift',
  '.m',
  '.mm',
  '.h',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.java',
  '.kt',
  '.kts',
  '.go',
  '.rs',
  '.rb',
  '.vue',
  '.svelte',
  '.c',
  '.cpp',
  '.cs',
]);

interface TargetInfo {
  discovererId?: string;
  discovererName?: string;
  framework?: string;
  info?: { path?: string; sources?: string; dependencies?: unknown[]; source?: string };
  isVirtual?: boolean;
  language?: string;
  metadata?: { dependencies?: unknown[]; fileCount?: number; source?: string };
  name: string;
  packageName?: string;
  packagePath?: string;
  path?: string;
  refs?: ProjectContextRef[];
  targetDir?: string;
  type?: string;
  [key: string]: unknown;
}

interface FileInfo {
  language?: string;
  name: string;
  path: string;
  relativePath: string;
  size?: number;
  [key: string]: unknown;
}

interface ProjectContextModuleSeed {
  configLayer?: string;
  kind?: string;
  moduleName: string;
  modulePath?: string;
  ownedFiles?: string[];
  ref?: ProjectContextRef;
  role?: string;
}

interface CanonicalModuleInfo {
  id?: string;
  name: string;
  path?: string;
  ownedFiles?: string[];
}

type ProjectContextTargetSummary = RepoContext['targets'][number];
type ProjectContextFileSummary = ModuleContext['ownedFiles'][number];

export class ModuleService {
  #projectRoot: string;
  #repoContext: RepoContext | null = null;
  #mapContext: ProjectMap | null = null;
  #targets: TargetInfo[] = [];
  #moduleFileCache = new Map<string, FileInfo[]>();
  #loaded = false;

  #logger: ReturnType<typeof Logger.getInstance>;

  #container;
  #recipeExtractor;
  #guardCheckEngine;
  #violationsStore;

  constructor(
    projectRoot: string,
    options: {
      container?: Record<string, unknown> | null;
      qualityScorer?: Record<string, unknown> | null;
      recipeExtractor?: Record<string, unknown> | null;
      guardCheckEngine?: Record<string, unknown> | null;
      violationsStore?: Record<string, unknown> | null;
    } = {}
  ) {
    this.#projectRoot = projectRoot;
    this.#logger = Logger.getInstance();
    this.#container = options.container || null;
    this.#recipeExtractor = options.recipeExtractor || null;
    this.#guardCheckEngine = options.guardCheckEngine || null;
    this.#violationsStore = options.violationsStore || null;
  }

  // ═══════════════════════════════════════════════════════
  //  Lifecycle
  // ═══════════════════════════════════════════════════════

  async load() {
    if (this.#loaded) {
      return;
    }

    const repoEnvelope = await this.#executeProjectContext('repo', {
      includeMapSummary: true,
      maxFiles: 2000,
    });
    this.#repoContext = isRepoContext(repoEnvelope.data) ? repoEnvelope.data : null;
    this.#targets = this.#repoContext ? this.#targetsFromRepo(this.#repoContext) : [];

    const moduleSeeds = this.#repoContext ? this.#moduleSeedsFromRepo(this.#repoContext) : [];
    if (moduleSeeds.length > 0) {
      const mapEnvelope = await this.#executeProjectContext('map', {
        moduleSeeds,
        repoName: this.#repoContext?.repo.name,
      });
      this.#mapContext = isProjectMap(mapEnvelope.data) ? mapEnvelope.data : null;
    }

    if (this.#targets.length === 0) {
      this.#logger.warn('[ModuleService] ProjectContext returned no project targets');
    } else {
      this.#logger.info(`[ModuleService] ProjectContext loaded ${this.#targets.length} targets`);
    }

    this.#loaded = true;
  }

  async reload() {
    this.#loaded = false;
    this.#repoContext = null;
    this.#mapContext = null;
    this.#targets = [];
    this.#moduleFileCache.clear();
    await this.load();
  }

  async #ensureLoaded() {
    if (!this.#loaded) {
      await this.load();
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Query — ProjectContext-backed
  // ═══════════════════════════════════════════════════════

  async listTargets() {
    await this.#ensureLoaded();
    return this.#targets.map((target) => ({ ...target }));
  }

  async getTargetFiles(target: string | Record<string, unknown>) {
    await this.#ensureLoaded();

    const targetObj = typeof target === 'string' ? this.#targetByName(target) : target;
    if (!targetObj) {
      return [];
    }

    if (
      targetObj.discovererId === 'folder-scan' &&
      typeof targetObj.path === 'string' &&
      existsSync(targetObj.path)
    ) {
      return this.#collectFolderFiles(targetObj.path);
    }

    const seed = this.#moduleSeedFromTarget(targetObj);
    if (!seed) {
      return [];
    }

    const cacheKey = JSON.stringify(seed);
    const cached = this.#moduleFileCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const files = await this.#queryModuleFiles(seed);
    this.#moduleFileCache.set(cacheKey, files);
    return files;
  }

  async getDependencyGraph(options: { level?: 'package' | 'target' } = {}) {
    await this.#ensureLoaded();

    const nodes = this.#mapContext?.modules
      ? this.#mapContext.modules.map((item) => ({
          id: item.id,
          label: item.name,
          type: item.kind || options.level || 'module',
          source: 'project-context',
          ...(item.ownedFileCount !== undefined ? { ownedFileCount: item.ownedFileCount } : {}),
        }))
      : this.#targets.map((item) => ({
          id: `target:${item.name}`,
          label: item.name,
          type: item.type || options.level || 'target',
          source: 'project-context',
        }));

    const edges = (this.#mapContext?.majorFlows ?? []).flatMap((flow, flowIndex) => {
      const refs = flow.refs ?? [];
      if (refs.length < 2) {
        return [];
      }
      return refs.slice(1).map((ref, index) => ({
        from: refs[0]?.id ?? `flow:${flowIndex}:source`,
        source: 'project-context',
        to: ref.id,
        type: flow.summary || `flow-${index + 1}`,
      }));
    });

    return {
      edges,
      generatedAt: new Date().toISOString(),
      nodes,
      projectRoot: this.#projectRoot,
    };
  }

  /**
   * U1 #5 / RF-9：canonical 模块轴只读投影。把已加载的 ProjectMap.modules 投成
   * {id,name,path,ownedFiles}，供 RecipeProductionGateway 与覆盖账本使用。
   * path 取自 module.ref.scope.filePath（ProjectMap 权威坐标），无 ref 的模块 path 留空。
   * ownedFiles 来自 ProjectContext module 查询；查不到时调用方才可用 path 做 Core segment-safe 目录兜底。
   */
  async listCanonicalModules(): Promise<CanonicalModuleInfo[]> {
    await this.#ensureLoaded();
    const modules = this.#mapContext?.modules ?? [];
    if (modules.length === 0) {
      return this.#fallbackCanonicalModulesFromRepo();
    }
    return await Promise.all(
      modules.map(async (module) => {
        const ownedFiles = await this.#ownedFilesForCanonicalModule(module);
        return {
          id: module.id,
          name: module.name,
          ...(module.ref?.scope.filePath ? { path: module.ref.scope.filePath } : {}),
          ...(ownedFiles.length > 0 ? { ownedFiles } : {}),
        };
      })
    );
  }

  #fallbackCanonicalModulesFromRepo(): CanonicalModuleInfo[] {
    if (!this.#repoContext) {
      return [];
    }
    const seeds = dedupeSeeds([
      ...this.#repoContext.localPackages.map((pkg) => ({
        kind: 'local-package',
        moduleName: pkg.name,
        modulePath: pkg.path ?? pkg.ref?.scope.filePath,
        ref: pkg.ref,
        role: 'local-package',
      })),
      ...this.#repoContext.sourceRoots.map((root) => ({
        kind: 'source-root',
        moduleName: moduleNameFromPath(root.path, root.role ?? 'source'),
        modulePath: root.path,
        ref: root.ref,
        role: root.role ?? 'source-root',
      })),
      ...this.#repoContext.topAreas
        .filter((area) => area.role === 'source-root' || area.role === 'top-directory')
        .map((area) => ({
          kind: 'project-area',
          moduleName: moduleNameFromPath(area.path, area.role ?? 'area'),
          modulePath: area.path,
          ref: area.ref,
          role: area.role ?? 'project-area',
        })),
    ]).filter((seed) => Boolean(normalizeProjectPath(this.#projectRoot, seed.modulePath)));

    const modules: CanonicalModuleInfo[] = [];
    const seenPaths = new Set<string>();
    const seenRealPaths = new Set<string>();
    for (const seed of seeds) {
      const modulePath = normalizeProjectPath(this.#projectRoot, seed.modulePath);
      const modulePathKey = moduleIdentityKey(modulePath);
      if (
        !modulePath ||
        !modulePathKey ||
        seenPaths.has(modulePathKey) ||
        hasMoreSpecificModulePath(seenPaths, modulePathKey)
      ) {
        continue;
      }
      const realPath = safeRealPath(_pathJoin(this.#projectRoot, modulePath));
      if (realPath && seenRealPaths.has(realPath)) {
        continue;
      }
      const ownedFiles = this.#collectProjectRelativeSourceFiles(modulePath);
      if (ownedFiles.length === 0) {
        continue;
      }
      seenPaths.add(modulePathKey);
      if (realPath) {
        seenRealPaths.add(realPath);
      }
      modules.push({
        id: modulePath,
        name: seed.moduleName,
        path: modulePath,
        ownedFiles,
      });
    }

    if (modules.length > 0) {
      this.#logger.info(
        `[ModuleService] ProjectContext map unavailable; using ${modules.length} repo-derived canonical modules`
      );
    }
    return modules;
  }

  getProjectInfo() {
    const repo = this.#repoContext;
    const languages = (repo?.languages ?? []).map((language) => language.language);
    const primaryLanguage =
      [...(repo?.languages ?? [])].sort(
        (left, right) => (right.fileCount ?? 0) - (left.fileCount ?? 0)
      )[0]?.language ?? 'unknown';

    return {
      discoverers: [
        {
          confidence: repo ? 1 : 0,
          id: 'project-context',
          name: 'ProjectContext',
        },
      ],
      hasSpm: (repo?.packageSystems ?? []).some((system) => system.kind === 'spm'),
      languages,
      primaryLanguage,
      projectName: repo?.repo.name ?? _pathBasename(this.#projectRoot) ?? '',
      projectRoot: this.#projectRoot,
    };
  }

  // ═══════════════════════════════════════════════════════
  //  Scanning
  // ═══════════════════════════════════════════════════════

  async scanTarget(
    target: string | Record<string, unknown>,
    options: { onProgress?: (event: Record<string, unknown>) => void } = {}
  ) {
    await this.#ensureLoaded();

    const targetName = typeof target === 'string' ? target : String(target?.name ?? '');
    const onProgress = options.onProgress;

    onProgress?.({ targetName, type: 'scan:started' });
    const fileList = await this.getTargetFiles(target);
    if (!fileList || fileList.length === 0) {
      return {
        message: `No source files found for module: ${targetName}`,
        recipes: [],
        scannedFiles: [],
      };
    }

    const scannedFilesMeta = fileList.map((f: Record<string, unknown>) => {
      const filePath = typeof f === 'string' ? f : (f.path as string);
      return { name: _pathBasename(filePath), path: f.relativePath || _pathBasename(filePath) };
    });
    onProgress?.({ count: fileList.length, files: scannedFilesMeta, type: 'scan:files-loaded' });

    onProgress?.({ count: fileList.length, type: 'scan:reading' });
    const files = fileList
      .map((f: Record<string, unknown>) => {
        const filePath = typeof f === 'string' ? f : (f.path as string);
        try {
          return {
            content: readFileSync(filePath, 'utf8'),
            name: _pathBasename(filePath),
            path: filePath,
            relativePath:
              ((f as Record<string, unknown>).relativePath as string) || _pathBasename(filePath),
          };
        } catch (err: unknown) {
          this.#logger.warn(
            `[ModuleService] Failed to read: ${filePath} — ${(err as Error).message}`
          );
          return null;
        }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);

    if (files.length === 0) {
      return { message: 'All source files unreadable', recipes: [], scannedFiles: [] };
    }

    const scannedFiles = files.map((f) => ({ name: f.name, path: f.relativePath }));
    this.#logger.info(`[ModuleService] scanTarget: ${targetName}, ${files.length} files`);

    const result: Record<string, unknown> = attachHostAgentManagedBoundary(
      {
        message:
          'AlembicPlugin 只返回模块文件扫描结果，不执行本地 AI 提取；请由 Codex host agent 或 Alembic resident service 使用扫描文件完成候选提交。',
        noAi: true,
        recipes: [],
        scannedFiles,
      },
      'module-target-scan'
    );
    onProgress?.({
      fileCount: scannedFiles.length,
      recipeCount: 0,
      type: 'scan:completed',
    });
    return result;
  }

  async scanProject(
    options: {
      maxFiles?: number;
      batchSize?: number;
      batchTimeout?: number;
      totalTimeout?: number;
    } = {}
  ) {
    await this.#ensureLoaded();
    this.#logger.info('[ModuleService] scanProject: starting full-project scan');

    const allTargets = await this.listTargets();
    const seenPaths = new Set<string>();
    const allFiles: Record<string, unknown>[] = [];
    const MAX_FILES = options.maxFiles || 200;

    if (allTargets && allTargets.length > 0) {
      for (const t of allTargets) {
        try {
          const fileList = await this.getTargetFiles(t);
          for (const f of fileList) {
            const fp = (typeof f === 'string' ? f : f.path) as string;
            if (seenPaths.has(fp)) {
              continue;
            }
            seenPaths.add(fp);
            try {
              const content = readFileSync(fp, 'utf8');
              allFiles.push({
                content,
                name: _pathBasename(fp),
                path: fp,
                relativePath: (f as Record<string, unknown>).relativePath || _pathBasename(fp),
                targetName: t.name,
              });
            } catch {
              /* unreadable */
            }
            if (allFiles.length >= MAX_FILES) {
              break;
            }
          }
        } catch (e: unknown) {
          this.#logger.warn(
            `[ModuleService] scanProject: skipping module ${t.name}: ${(e as Error).message}`
          );
        }
        if (allFiles.length >= MAX_FILES) {
          break;
        }
      }
    }

    if (allFiles.length === 0) {
      this.#logger.info(
        '[ModuleService] scanProject: No ProjectContext module files, falling back to directory scan'
      );
      this.#walkProjectForFiles(allFiles, seenPaths, MAX_FILES);
    }

    this.#logger.info(
      `[ModuleService] scanProject: ${allFiles.length} unique files from ${allTargets?.length || 0} modules`
    );

    if (allFiles.length === 0) {
      return {
        guardAudit: null,
        message: 'No readable source files',
        recipes: [],
        scannedFiles: [],
        targets: (allTargets || []).map((t) => t.name),
      };
    }

    const scannedFiles = allFiles.map((f) => ({
      name: f.name,
      path: f.relativePath,
      targetName: f.targetName,
    }));

    let guardAudit: Record<string, unknown> | null = null;
    if (this.#guardCheckEngine) {
      try {
        const guardFiles = allFiles.map((f) => ({
          content: f.content as string,
          path: f.path as string,
        }));
        const engine = this.#guardCheckEngine as {
          auditFiles(
            files: { path: string; content: string }[],
            opts: Record<string, unknown>
          ): Record<string, unknown>;
        };
        guardAudit = engine.auditFiles(guardFiles, { scope: 'project' });

        if (this.#violationsStore && guardAudit && guardAudit.files) {
          const auditFileResults = guardAudit.files as Array<{
            filePath: string;
            summary: { errors: number; warnings: number };
            violations: unknown[];
          }>;
          const store = this.#violationsStore as { appendRun(data: Record<string, unknown>): void };
          for (const fileResult of auditFileResults) {
            if (fileResult.violations.length > 0) {
              store.appendRun({
                filePath: fileResult.filePath,
                summary: `Project scan: ${fileResult.summary.errors} errors, ${fileResult.summary.warnings} warnings`,
                violations: fileResult.violations,
              });
            }
          }
        }
      } catch (e: unknown) {
        this.#logger.warn(`[ModuleService] Guard audit failed: ${(e as Error).message}`);
      }
    }

    this.#logger.info(
      `[ModuleService] scanProject complete: 0 local recipes, ${(guardAudit?.summary as Record<string, unknown> | undefined)?.totalViolations || 0} violations`
    );

    return attachHostAgentManagedBoundary(
      {
        guardAudit,
        message:
          'AlembicPlugin 只返回项目扫描与 Guard 结果，不执行本地 AI 提取；请由 Codex host agent 或 Alembic resident service 使用扫描结果完成候选提交。',
        recipes: [],
        scannedFiles,
        targets: allTargets.map((t) => t.name),
      },
      'module-project-scan'
    );
  }

  async updateModuleMap(_options: Record<string, unknown> = {}) {
    await this.reload();
    const targets = await this.listTargets();
    const graph = await this.getDependencyGraph();

    return {
      edges: (graph.edges || []).length,
      message: `Module map updated (${targets.length} modules)`,
      projectRoot: this.#projectRoot,
      success: true,
      targets: targets.length,
    };
  }

  // ═══════════════════════════════════════════════════════
  //  Folder Scanning — 目录浏览与手动扫描
  // ═══════════════════════════════════════════════════════

  async browseDirectories(basePath = '', maxDepth = 2) {
    const root = basePath ? _pathJoin(this.#projectRoot, basePath) : this.#projectRoot;

    if (!existsSync(root)) {
      return [];
    }

    const dirs: {
      depth: number;
      hasSourceFiles: boolean;
      language: string;
      name: string;
      path: string;
      sourceFileCount: number;
    }[] = [];
    this.#walkDirsForBrowse(root, dirs, 0, maxDepth);
    return dirs;
  }

  async scanFolder(
    folderPath: string,
    options: { onProgress?: (event: Record<string, unknown>) => void } = {}
  ) {
    await this.#ensureLoaded();

    const absPath = _pathIsAbsolute(folderPath)
      ? folderPath
      : _pathJoin(this.#projectRoot, folderPath);

    if (!existsSync(absPath)) {
      throw new Error(`目录不存在: ${folderPath}`);
    }

    const lang = this.#detectFolderLanguage(absPath);
    const folderName = _pathBasename(absPath);

    const virtualTarget = {
      discovererId: 'folder-scan',
      discovererName: '目录扫描',
      info: { originalPath: folderPath, source: 'manual-folder-scan' },
      isVirtual: true,
      language: lang,
      name: folderName,
      packageName: folderName,
      packagePath: absPath,
      path: absPath,
      targetDir: absPath,
      type: 'directory',
    };

    this.#logger.info(`[ModuleService] scanFolder: ${folderPath} (lang=${lang})`);
    return this.scanTarget(virtualTarget, options);
  }

  static normalizeSemanticFields(recipe: Record<string, unknown>) {
    return recipe;
  }

  // ═══════════════════════════════════════════════════════
  //  ProjectContext Helpers
  // ═══════════════════════════════════════════════════════

  async #executeProjectContext(
    kind: ProjectContextRequestKind,
    payload?: Record<string, unknown>
  ): Promise<ProjectContextEnvelope<ProjectContextResult>> {
    return ProjectContextCapabilities.execute({
      kind,
      payload,
      project: {
        displayName: _pathBasename(this.#projectRoot),
        projectRoot: this.#projectRoot,
        source: 'alembic-plugin-module-service',
      },
      scope: {
        projectRoot: this.#projectRoot,
      },
    });
  }

  #targetsFromRepo(repo: RepoContext): TargetInfo[] {
    const targets = repo.targets.map((target) => this.#targetFromSummary(target, repo));
    if (targets.length > 0) {
      return targets;
    }
    const packageTargets = repo.localPackages.map((pkg) =>
      this.#targetFromPath({
        kind: 'local-package',
        name: pkg.name,
        path: pkg.path,
        ref: pkg.ref,
      })
    );
    const pathTargets = [...repo.sourceRoots, ...repo.topAreas].map((item) =>
      this.#targetFromPath({
        kind: 'project-area',
        name: moduleNameFromPath(item.path, item.role ?? 'project-area'),
        path: item.path,
        ref: item.ref,
      })
    );
    return [...packageTargets, ...pathTargets];
  }

  #targetFromSummary(target: ProjectContextTargetSummary, repo: RepoContext): TargetInfo {
    const ref = target.refs[0];
    const metadata = readMetadata(ref);
    const targetPath = readString(ref?.scope.filePath) ?? '.';
    const fileCount = readNumber(metadata.fileCount);
    const language =
      readString(metadata.language) ??
      repo.languages[0]?.language ??
      inferLang(targetPath) ??
      'unknown';
    return {
      discovererId: 'project-context',
      discovererName: 'ProjectContext',
      framework: readString(metadata.framework),
      info: { path: targetPath, source: 'project-context-repo-target' },
      language,
      metadata: { fileCount, source: 'project-context' },
      name: target.name,
      packageName: target.name,
      packagePath: targetPath,
      path: targetPath,
      refs: target.refs,
      targetDir: targetPath,
      type: target.kind || readString(metadata.role) || 'target',
    };
  }

  #targetFromPath(input: {
    kind: string;
    name: string;
    path?: string;
    ref?: ProjectContextRef;
  }): TargetInfo {
    const targetPath = input.path ?? input.ref?.scope.filePath ?? '.';
    return {
      discovererId: 'project-context',
      discovererName: 'ProjectContext',
      info: { path: targetPath, source: 'project-context-path' },
      language: inferLang(targetPath) || 'unknown',
      metadata: { source: 'project-context' },
      name: input.name,
      packageName: input.name,
      packagePath: targetPath,
      path: targetPath,
      refs: input.ref ? [input.ref] : [],
      targetDir: targetPath,
      type: input.kind,
    };
  }

  #moduleSeedsFromRepo(repo: RepoContext): ProjectContextModuleSeed[] {
    const seeds: ProjectContextModuleSeed[] = [];
    seeds.push(
      ...repo.targets.flatMap((target) =>
        target.refs.map((ref) => ({
          kind: target.kind ?? 'target',
          moduleName: target.name,
          modulePath: ref.scope.filePath,
          ref,
          role: 'target',
        }))
      )
    );
    seeds.push(
      ...repo.localPackages.map((pkg) => ({
        kind: 'local-package',
        moduleName: pkg.name,
        modulePath: pkg.path ?? pkg.ref?.scope.filePath,
        ref: pkg.ref,
        role: 'local-package',
      }))
    );
    seeds.push(
      ...repo.sourceRoots.map((root) => ({
        kind: 'source-root',
        moduleName: moduleNameFromPath(root.path, root.role ?? 'source'),
        modulePath: root.path,
        ref: root.ref,
        role: root.role ?? 'source-root',
      }))
    );
    return dedupeSeeds(
      seeds.filter((seed) => Boolean(seed.modulePath || seed.ownedFiles?.length))
    ).slice(0, 24);
  }

  #targetByName(targetName: string): TargetInfo | null {
    return this.#targets.find((target) => target.name === targetName) ?? null;
  }

  #moduleSeedFromTarget(target: Record<string, unknown>): ProjectContextModuleSeed | null {
    const name = readString(target.name);
    if (!name) {
      return null;
    }
    const refs = readRefArray(target.refs);
    const ref = refs[0];
    const pathValue = readString(target.path) ?? ref?.scope.filePath;
    const relativePath = normalizeProjectPath(this.#projectRoot, pathValue);
    const absolutePath = relativePath ? _pathJoin(this.#projectRoot, relativePath) : undefined;
    const ownedFiles =
      absolutePath && isExistingSourceFile(absolutePath) && relativePath ? [relativePath] : [];
    return {
      kind: readString(target.type) ?? 'target',
      moduleName: name,
      ...(relativePath
        ? {
            modulePath: isExistingSourceFile(absolutePath)
              ? _pathDirname(relativePath)
              : relativePath,
          }
        : {}),
      ...(ownedFiles.length > 0 ? { ownedFiles } : {}),
      ref,
      role: readString(target.type) ?? 'target',
    };
  }

  #moduleSeedFromModuleSummary(
    module: ProjectMap['modules'][number]
  ): ProjectContextModuleSeed | null {
    const modulePath = readString(module.ref?.scope.filePath);
    if (!modulePath) {
      return null;
    }
    return {
      kind: module.kind ?? 'module',
      moduleName: module.name,
      modulePath,
      ref: module.ref,
      role: module.role ?? module.kind ?? 'module',
    };
  }

  async #ownedFilesForCanonicalModule(module: ProjectMap['modules'][number]): Promise<string[]> {
    const seed = this.#moduleSeedFromModuleSummary(module);
    if (!seed) {
      return [];
    }
    const cacheKey = `canonical:${module.id}:${JSON.stringify(seed)}`;
    const cached = this.#moduleFileCache.get(cacheKey);
    if (cached) {
      return uniqueStrings(cached.map((file) => file.relativePath));
    }
    const files = await this.#queryModuleFiles(seed);
    this.#moduleFileCache.set(cacheKey, files);
    return uniqueStrings(files.map((file) => file.relativePath));
  }

  async #queryModuleFiles(seed: ProjectContextModuleSeed): Promise<FileInfo[]> {
    try {
      const envelope = await this.#executeProjectContext('module', {
        ...seed,
        includeDependencies: true,
        includePublicSurfaces: false,
      });
      if (!isModuleContext(envelope.data)) {
        this.#logger.warn(
          `[ModuleService] ProjectContext module unavailable for ${seed.moduleName}`
        );
        return [];
      }
      return envelope.data.ownedFiles.map((file) => this.#fileInfoFromSummary(file));
    } catch (err: unknown) {
      this.#logger.warn(
        `[ModuleService] ProjectContext module query failed for ${seed.moduleName}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return [];
    }
  }

  #fileInfoFromSummary(file: ProjectContextFileSummary): FileInfo {
    const relativePath = normalizeProjectPath(this.#projectRoot, file.filePath) ?? file.filePath;
    const absolutePath = _pathIsAbsolute(file.filePath)
      ? file.filePath
      : _pathJoin(this.#projectRoot, relativePath);
    return {
      language: file.language ?? inferLang(file.filePath) ?? 'unknown',
      name: _pathBasename(file.filePath),
      path: absolutePath,
      relativePath,
      ...(file.mtimeMs !== undefined ? { mtimeMs: file.mtimeMs } : {}),
      ...(file.lineCount !== undefined ? { lineCount: file.lineCount } : {}),
    };
  }

  // ═══════════════════════════════════════════════════════
  //  Folder Helpers
  // ═══════════════════════════════════════════════════════

  #walkDirsForBrowse(
    dir: string,
    dirs: {
      depth: number;
      hasSourceFiles: boolean;
      language: string;
      name: string;
      path: string;
      sourceFileCount: number;
    }[],
    depth: number,
    maxDepth: number
  ) {
    if (depth >= maxDepth) {
      return;
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          entry.name.startsWith('.') ||
          SCAN_EXCLUDE_DIRS.has(entry.name)
        ) {
          continue;
        }

        const fullPath = _pathJoin(dir, entry.name);
        const relativePath = relative(this.#projectRoot, fullPath);
        const sourceFileCount = this.#countSourceFilesDeep(fullPath, 8);
        const lang = sourceFileCount > 0 ? this.#detectFolderLanguage(fullPath) : 'unknown';

        dirs.push({
          depth,
          hasSourceFiles: sourceFileCount > 0,
          language: lang,
          name: entry.name,
          path: relativePath,
          sourceFileCount,
        });

        this.#walkDirsForBrowse(fullPath, dirs, depth + 1, maxDepth);
      }
    } catch {
      /* skip */
    }
  }

  #countSourceFilesDeep(dir: string, maxDepth: number, depth = 0) {
    if (depth >= maxDepth) {
      return 0;
    }
    let count = 0;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && SOURCE_CODE_EXTS.has(_pathExtname(e.name).toLowerCase())) {
          count++;
        } else if (e.isDirectory() && !e.name.startsWith('.') && !SCAN_EXCLUDE_DIRS.has(e.name)) {
          count += this.#countSourceFilesDeep(_pathJoin(dir, e.name), maxDepth, depth + 1);
        }
        if (count >= 999) {
          return count;
        }
      }
    } catch {
      /* skip */
    }
    return count;
  }

  #collectFolderFiles(dirPath: string, maxDepth = 15) {
    const files: FileInfo[] = [];
    this.#walkCollectSourceFiles(dirPath, dirPath, files, 0, maxDepth);
    return files;
  }

  #collectProjectRelativeSourceFiles(modulePath: string, maxDepth = 15): string[] {
    const absolutePath = _pathJoin(this.#projectRoot, modulePath);
    if (isExistingSourceFile(absolutePath)) {
      return [modulePath];
    }
    const files: string[] = [];
    this.#walkCollectProjectRelativeSourceFiles(absolutePath, files, 0, maxDepth);
    return uniqueStrings(files);
  }

  #walkCollectProjectRelativeSourceFiles(
    dir: string,
    files: string[],
    depth: number,
    maxDepth: number
  ): void {
    if (depth > maxDepth || files.length > 500) {
      return;
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || SCAN_EXCLUDE_DIRS.has(entry.name)) {
          continue;
        }
        const fullPath = _pathJoin(dir, entry.name);
        if (entry.isDirectory()) {
          this.#walkCollectProjectRelativeSourceFiles(fullPath, files, depth + 1, maxDepth);
          continue;
        }
        if (!entry.isFile() || !SOURCE_CODE_EXTS.has(_pathExtname(entry.name).toLowerCase())) {
          continue;
        }
        const relativePath = relative(this.#projectRoot, fullPath);
        if (!relativePath.startsWith('..')) {
          files.push(relativePath);
        }
      }
    } catch {
      /* skip */
    }
  }

  #walkCollectSourceFiles(
    dir: string,
    rootDir: string,
    files: FileInfo[],
    depth: number,
    maxDepth: number
  ) {
    if (depth > maxDepth || files.length > 500) {
      return;
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || SCAN_EXCLUDE_DIRS.has(entry.name)) {
          continue;
        }

        const fullPath = _pathJoin(dir, entry.name);
        if (entry.isDirectory()) {
          this.#walkCollectSourceFiles(fullPath, rootDir, files, depth + 1, maxDepth);
        } else if (entry.isFile()) {
          const ext = _pathExtname(entry.name).toLowerCase();
          if (SOURCE_CODE_EXTS.has(ext)) {
            files.push({
              language: inferLang(entry.name) || 'unknown',
              name: entry.name,
              path: fullPath,
              relativePath: relative(rootDir, fullPath),
            });
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  #detectFolderLanguage(dirPath: string) {
    const langCount: Record<string, number> = {};
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const ext = _pathExtname(entry.name).toLowerCase();
        if (!SOURCE_CODE_EXTS.has(ext)) {
          continue;
        }
        const lang = inferLang(entry.name);
        if (lang) {
          langCount[lang] = (langCount[lang] || 0) + 1;
        }
      }
    } catch {
      /* skip */
    }

    let maxLang = 'unknown';
    let maxCount = 0;
    for (const [lang, count] of Object.entries(langCount)) {
      if (count > maxCount) {
        maxCount = count;
        maxLang = lang;
      }
    }
    return maxLang;
  }

  #walkProjectForFiles(
    allFiles: Record<string, unknown>[],
    seenPaths: Set<string>,
    maxFiles: number
  ) {
    const srcDirs = [
      'Sources',
      'src',
      'lib',
      'app',
      'pages',
      'components',
      'modules',
      'packages',
      'cmd',
      'internal',
      'pkg',
    ];

    const walkDir = (dir: string, targetName: string) => {
      if (allFiles.length >= maxFiles) {
        return;
      }
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (allFiles.length >= maxFiles) {
          break;
        }
        if (ent.name.startsWith('.')) {
          continue;
        }
        const fp = _pathJoin(dir, ent.name);
        if (ent.isDirectory()) {
          if (SCAN_EXCLUDE_DIRS.has(ent.name)) {
            continue;
          }
          walkDir(fp, targetName);
        } else if (ent.isFile() && SOURCE_CODE_EXTS.has(_pathExtname(ent.name).toLowerCase())) {
          if (seenPaths.has(fp)) {
            continue;
          }
          seenPaths.add(fp);
          try {
            const st = statSync(fp);
            if (st.size > 512 * 1024) {
              continue;
            }
            const content = readFileSync(fp, 'utf8');
            if (content.split('\n').length < 5) {
              continue;
            }
            allFiles.push({
              content,
              name: ent.name,
              path: fp,
              relativePath: relative(this.#projectRoot, fp),
              targetName,
            });
          } catch {
            /* unreadable */
          }
        }
      }
    };

    for (const dir of srcDirs) {
      const dirPath = _pathJoin(this.#projectRoot, dir);
      if (existsSync(dirPath)) {
        walkDir(dirPath, dir);
      }
    }

    if (allFiles.length === 0) {
      walkDir(this.#projectRoot, 'root');
    }
  }
}

function isRepoContext(value: ProjectContextResult): value is RepoContext {
  return 'repo' in value && 'targets' in value && 'sourceRoots' in value;
}

function isProjectMap(value: ProjectContextResult): value is ProjectMap {
  return 'modules' in value && 'dependencySummary' in value && 'majorFlows' in value;
}

function isModuleContext(value: ProjectContextResult): value is ModuleContext {
  return 'module' in value && 'ownedFiles' in value && 'publicSurfaces' in value;
}

function readMetadata(ref: ProjectContextRef | undefined): Record<string, unknown> {
  return ref?.metadata && typeof ref.metadata === 'object' ? ref.metadata : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function readRefArray(value: unknown): ProjectContextRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isProjectContextRef);
}

function isProjectContextRef(value: unknown): value is ProjectContextRef {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as ProjectContextRef).id === 'string' &&
    typeof (value as ProjectContextRef).kind === 'string' &&
    Boolean((value as ProjectContextRef).scope)
  );
}

function normalizeProjectPath(projectRoot: string, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const absolute = _pathIsAbsolute(value) ? _pathResolve(value) : _pathResolve(projectRoot, value);
  const relativePath = relative(projectRoot, absolute);
  if (relativePath.startsWith('..') || _pathIsAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath || '.';
}

function isExistingSourceFile(pathValue: string | undefined): boolean {
  if (!pathValue) {
    return false;
  }
  try {
    const stat = statSync(pathValue);
    return stat.isFile() && SOURCE_CODE_EXTS.has(_pathExtname(pathValue).toLowerCase());
  } catch {
    return false;
  }
}

function moduleIdentityKey(modulePath: string | undefined): string | undefined {
  return modulePath?.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function hasMoreSpecificModulePath(seenPaths: ReadonlySet<string>, modulePathKey: string): boolean {
  for (const seen of seenPaths) {
    if (seen.startsWith(`${modulePathKey}/`)) {
      return true;
    }
  }
  return false;
}

function safeRealPath(pathValue: string): string | undefined {
  try {
    return realpathSync.native(pathValue);
  } catch {
    return undefined;
  }
}

function moduleNameFromPath(pathValue: string, fallback: string): string {
  return (
    pathValue
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.replace(/\.[^.]+$/, '') || fallback
  );
}

function dedupeSeeds(seeds: readonly ProjectContextModuleSeed[]): ProjectContextModuleSeed[] {
  const byKey = new Map<string, ProjectContextModuleSeed>();
  for (const seed of seeds) {
    const key = `${seed.modulePath ?? seed.ownedFiles?.join(',') ?? ''}:${seed.moduleName}`;
    if (!byKey.has(key)) {
      byKey.set(key, seed);
    }
  }
  return [...byKey.values()];
}
