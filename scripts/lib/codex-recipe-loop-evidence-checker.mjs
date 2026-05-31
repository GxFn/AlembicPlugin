import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceResolver } from '@alembic/core/workspace';
import Database from 'better-sqlite3';

export function checkRecipeLoopEvidence(options) {
  const projectRoot = path.resolve(required(options.projectRoot, 'projectRoot'));
  const dimensionId = options.dimensionId || 'architecture';
  const transcriptPath = options.transcriptPath ? path.resolve(options.transcriptPath) : '';
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  const transcript = transcriptPath ? readTranscript(transcriptPath) : [];
  const toolFacts = collectTranscriptToolFacts(transcript);
  const database = inspectDatabase(resolver.databasePath, dimensionId);
  const recipeFiles = listMarkdownFiles(resolver.recipesDir, new Set(['_template.md']));
  const recipePersisted = database.dimensionEntries.length > 0;
  const errors = [];
  const warnings = [];
  const requiredOrder = [
    'alembic_bootstrap',
    'alembic_submit_knowledge',
    'alembic_dimension_complete',
    'alembic_rescan',
  ];

  if (!database.knowledgeEntries.tableExists) {
    errors.push('knowledge_entries table does not exist.');
  }
  if (database.knowledgeEntries.totalEntries < 1) {
    errors.push('knowledge_entries has no persisted Recipe rows.');
  }
  if (database.dimensionEntries.length < 1) {
    errors.push(`No knowledge_entries row has dimensionId="${dimensionId}".`);
  }
  if (
    !database.dimensionEntries.some(
      (entry) => typeof entry.lifecycle === 'string' && entry.lifecycle.length > 0
    )
  ) {
    errors.push('No architecture entry exposes a lifecycle value.');
  }
  if (!hasSourceReference(database)) {
    errors.push(
      'No architecture entry exposes source refs through recipe_source_refs, reasoning.sources, or sourceFile.'
    );
  }

  const orderCheck = checkOrderedSubset(toolFacts.toolOrder, requiredOrder);
  if (!orderCheck.ok) {
    errors.push(
      `Transcript tool order is missing ${orderCheck.missing}: saw ${toolFacts.toolOrder.join(' -> ') || 'none'}.`
    );
  }
  const rescanCall = toolFacts.calls.find((call) => call.name === 'alembic_rescan');
  if (!rescanCall) {
    errors.push('Transcript has no alembic_rescan call.');
  } else if (!arrayContains(rescanCall.arguments?.dimensions, dimensionId)) {
    errors.push(`alembic_rescan must be called with dimensions including "${dimensionId}".`);
  }
  const rescanResult = toolFacts.results.find((result) => result.name === 'alembic_rescan')?.result;
  const rescanEvidenceSurface = detectRescanEvidenceSurface(rescanResult);
  if (!rescanEvidenceSurface) {
    errors.push('alembic_rescan result contains neither evidenceHints nor evidencePlan.');
  }
  const dimensionCompleteResult = toolFacts.results.find(
    (result) => result.name === 'alembic_dimension_complete'
  )?.result;
  const runtimeSkillExportBlocked = isPathGuardRuntimeSkillExportBlocked(dimensionCompleteResult);
  if (runtimeSkillExportBlocked) {
    warnings.push(
      'Runtime Skill export was blocked by PathGuard; this is outside the architecture Recipe loop pass/fail scope.'
    );
  }

  const submittedIds = extractSubmittedRecipeIds(toolFacts.results);
  const missingSubmittedIds = submittedIds.filter(
    (id) => !database.knowledgeEntries.ids.includes(id)
  );
  if (submittedIds.length === 0) {
    errors.push('No submitted Recipe id was found in alembic_submit_knowledge result.');
  } else if (missingSubmittedIds.length > 0) {
    errors.push(`Submitted Recipe ids missing after rescan: ${missingSubmittedIds.join(', ')}.`);
  }

  const duplicates = findDuplicateArchitectureEntries(database.dimensionEntries);
  if (duplicates.length > 0) {
    errors.push(`Duplicate architecture Recipe fingerprints found: ${duplicates.join(', ')}.`);
  }

  const report = {
    ok: errors.length === 0,
    errors,
    warnings,
    projectRoot,
    dimensionId,
    transcriptPath: transcriptPath || null,
    summary: {
      recipeFiles: recipeFiles.length,
      recipePersisted,
      knowledgeEntries: database.knowledgeEntries.totalEntries,
      dimensionEntries: database.dimensionEntries.length,
      sourceRefs: database.sourceRefs.length,
      submittedRecipeIds: submittedIds,
      toolOrder: toolFacts.toolOrder,
      rescanEvidenceHintsFound: containsKey(rescanResult, 'evidenceHints'),
      rescanEvidencePlanFound: containsKey(rescanResult, 'evidencePlan'),
      rescanEvidenceSurface,
      runtimeSkillExportBlocked,
      noDuplicateArchitectureRecipe: duplicates.length === 0,
    },
    details: {
      databasePath: resolver.databasePath,
      recipesDir: resolver.recipesDir,
      recipeFiles,
      duplicateFingerprints: duplicates,
      missingSubmittedIds,
    },
  };
  if (options.reportPath) {
    const reportPath = path.resolve(options.reportPath);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    report.reportPath = reportPath;
  }
  return report;
}

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readTranscript(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript does not exist: ${transcriptPath}`);
  }
  return fs
    .readFileSync(transcriptPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function collectTranscriptToolFacts(events) {
  const calls = [];
  const results = [];
  for (const event of events) {
    if ((event.type === 'codex.tool_call' || event.type === 'agent.tool_call') && event.tool) {
      calls.push({
        arguments: event.data?.arguments || {},
        name: event.tool,
        turn: event.turn || null,
      });
    }
    if (event.type === 'tool.result' && event.tool) {
      results.push({
        name: event.tool,
        result: event.data || {},
        turn: event.turn || null,
      });
    }
  }
  return {
    calls,
    results,
    toolOrder: calls.map((call) => call.name),
  };
}

function inspectDatabase(databasePath, dimensionId) {
  const empty = {
    dimensionEntries: [],
    knowledgeEntries: {
      ids: [],
      tableExists: false,
      totalEntries: 0,
    },
    sourceRefs: [],
  };
  if (!fs.existsSync(databasePath)) {
    return empty;
  }
  const db = new Database(databasePath, { fileMustExist: true, readonly: true });
  try {
    if (!tableExists(db, 'knowledge_entries')) {
      return empty;
    }
    const rows = db
      .prepare(
        'SELECT id, title, trigger, coreCode, lifecycle, dimensionId, sourceFile, reasoning FROM knowledge_entries'
      )
      .all();
    const sourceRefs = tableExists(db, 'recipe_source_refs')
      ? db.prepare('SELECT recipe_id, source_path, status FROM recipe_source_refs').all()
      : [];
    return {
      dimensionEntries: rows.filter((row) => row.dimensionId === dimensionId),
      knowledgeEntries: {
        ids: rows.map((row) => row.id).filter(Boolean),
        tableExists: true,
        totalEntries: rows.length,
      },
      sourceRefs,
    };
  } finally {
    db.close();
  }
}

function tableExists(db, tableName) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function hasSourceReference(database) {
  if (database.sourceRefs.length > 0) {
    return true;
  }
  return database.dimensionEntries.some((entry) => {
    if (typeof entry.sourceFile === 'string' && entry.sourceFile.length > 0) {
      return true;
    }
    const reasoning = parseJsonObject(entry.reasoning);
    return Array.isArray(reasoning.sources) && reasoning.sources.length > 0;
  });
}

function extractSubmittedRecipeIds(results) {
  const ids = [];
  for (const result of results.filter((item) => item.name === 'alembic_submit_knowledge')) {
    collectIds(result.result, ids);
  }
  return [...new Set(ids)];
}

function collectIds(value, ids) {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectIds(item, ids);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (
      (key === 'id' || key === 'ids' || key === 'recipeId' || key === 'submittedRecipeIds') &&
      typeof nested === 'string'
    ) {
      ids.push(nested);
    } else if (Array.isArray(nested) && (key === 'ids' || key === 'submittedRecipeIds')) {
      for (const item of nested) {
        if (typeof item === 'string') {
          ids.push(item);
        } else {
          collectIds(item, ids);
        }
      }
    } else {
      collectIds(nested, ids);
    }
  }
}

function findDuplicateArchitectureEntries(entries) {
  const seen = new Map();
  const duplicates = [];
  for (const entry of entries) {
    const fingerprint = [entry.title, entry.trigger, entry.coreCode]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .join('|');
    if (!fingerprint.replace(/\|/g, '')) {
      continue;
    }
    const count = seen.get(fingerprint) || 0;
    seen.set(fingerprint, count + 1);
    if (count === 1) {
      duplicates.push(fingerprint);
    }
  }
  return duplicates;
}

function listMarkdownFiles(dir, excludeNames = new Set()) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...listMarkdownFiles(fullPath, excludeNames).map((child) => path.join(entry.name, child))
      );
    } else if (entry.isFile() && entry.name.endsWith('.md') && !excludeNames.has(entry.name)) {
      files.push(entry.name);
    }
  }
  return files.sort();
}

function checkOrderedSubset(actual, expected) {
  let cursor = 0;
  for (const name of actual) {
    if (name === expected[cursor]) {
      cursor += 1;
    }
  }
  return {
    ok: cursor === expected.length,
    missing: expected[cursor] || null,
  };
}

function arrayContains(value, item) {
  return Array.isArray(value) && value.includes(item);
}

function containsKey(value, key) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Object.hasOwn(value, key)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsKey(item, key));
  }
  return Object.values(value).some((item) => containsKey(item, key));
}

function detectRescanEvidenceSurface(value) {
  if (containsKey(value, 'evidenceHints')) {
    return 'evidenceHints';
  }
  if (containsKey(value, 'evidencePlan')) {
    return 'evidencePlan';
  }
  return null;
}

function isPathGuardRuntimeSkillExportBlocked(value) {
  const runtimeExport = findNestedObjectByKey(value, 'runtimeExport');
  if (!runtimeExport) {
    return false;
  }
  const status = runtimeExport.status;
  const message = runtimeExport.message;
  return (
    status === 'failed' &&
    typeof message === 'string' &&
    message.toLowerCase().includes('pathguard')
  );
}

function findNestedObjectByKey(value, key) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (Object.hasOwn(value, key)) {
    const found = value[key];
    return found && typeof found === 'object' ? found : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedObjectByKey(item, key);
      if (found) {
        return found;
      }
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const found = findNestedObjectByKey(item, key);
    if (found) {
      return found;
    }
  }
  return null;
}

function parseJsonObject(value) {
  if (!value || typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
