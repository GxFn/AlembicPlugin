/**
 * 集成测试：Zod Schemas — MCP/HTTP/Config 运行时校验
 *
 * 覆盖范围:
 *   - common.ts 基础 schema（PaginationSchema, ContentSchema, ReasoningSchema 等）
 *   - mcp-tools.ts MCP 工具输入 schema（SearchInput, KnowledgeInput, TaskInput 等）
 *   - http-requests.ts HTTP 路由 schema（CRUD + 批量 + 搜索）
 *   - config.ts 配置文件 schema（AppConfigSchema, compatibility policy schema）
 *   - TOOL_SCHEMAS 映射表完整性
 */

// ── common schemas ──────────────────────────────────
// ── config schemas ──────────────────────────────────
import {
  AppConfigSchema,
  ComplexityEnum,
  ConstitutionSchema,
  ContentSchema,
  IdField,
  KindEnum,
  KnowledgeTypeEnum,
  LanguageField,
  PaginationSchema,
  ReasoningSchema,
  ScopeEnum,
  StrictKindEnum,
  TitleField,
} from '@alembic/core/shared';
import { z } from 'zod';

// ── HTTP request schemas ────────────────────────────
import {
  AuthLoginBody,
  BatchPublishBody,
  CreateKnowledgeBody,
  SearchQuery,
  UpdateKnowledgeBody,
} from '../../lib/shared/schemas/http-requests.js';
// ── MCP tools schemas ───────────────────────────────
import {
  GraphInput,
  GuardInput,
  HealthInput,
  KnowledgeInput,
  SearchInput,
  StructureInput,
  SubmitKnowledgeInput,
  TaskInput,
  TOOL_SCHEMAS,
} from '../../lib/shared/schemas/mcp-tools.js';

describe('Integration: Zod Schemas — common.ts', () => {
  describe('PaginationSchema', () => {
    test('should apply defaults', () => {
      const result = PaginationSchema.parse({});
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);
    });

    test('should accept valid values', () => {
      const result = PaginationSchema.parse({ limit: 50, offset: 100 });
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(100);
    });

    test('should reject out-of-range values', () => {
      expect(() => PaginationSchema.parse({ limit: 0 })).toThrow();
      expect(() => PaginationSchema.parse({ limit: 201 })).toThrow();
      expect(() => PaginationSchema.parse({ offset: -1 })).toThrow();
    });
  });

  describe('Enums', () => {
    test('KindEnum should accept valid values', () => {
      expect(KindEnum.parse('all')).toBe('all');
      expect(KindEnum.parse('rule')).toBe('rule');
      expect(KindEnum.parse('pattern')).toBe('pattern');
      expect(KindEnum.parse('fact')).toBe('fact');
    });

    test('KindEnum should reject invalid values', () => {
      expect(() => KindEnum.parse('invalid')).toThrow();
    });

    test('StrictKindEnum should not accept "all"', () => {
      expect(() => StrictKindEnum.parse('all')).toThrow();
      expect(StrictKindEnum.parse('rule')).toBe('rule');
    });

    test('KnowledgeTypeEnum should accept all knowledge types', () => {
      const validTypes = [
        'code-pattern',
        'architecture',
        'best-practice',
        'code-standard',
        'code-style',
        'code-relation',
        'data-flow',
        'event-and-data-flow',
        'module-dependency',
        'boundary-constraint',
        'solution',
        'anti-pattern',
      ];
      for (const t of validTypes) {
        expect(KnowledgeTypeEnum.parse(t)).toBe(t);
      }
    });

    test('ComplexityEnum should accept valid values', () => {
      expect(ComplexityEnum.parse('beginner')).toBe('beginner');
      expect(ComplexityEnum.parse('intermediate')).toBe('intermediate');
      expect(ComplexityEnum.parse('advanced')).toBe('advanced');
    });

    test('ScopeEnum should accept valid values', () => {
      expect(ScopeEnum.parse('universal')).toBe('universal');
      expect(ScopeEnum.parse('project-specific')).toBe('project-specific');
    });
  });

  describe('ContentSchema', () => {
    test('should accept valid content with pattern', () => {
      const result = ContentSchema.parse({
        pattern: 'some pattern',
        rationale: 'because',
      });
      expect(result.pattern).toBe('some pattern');
    });

    test('should accept valid content with markdown', () => {
      const result = ContentSchema.parse({
        markdown: '# Title',
        rationale: 'because',
      });
      expect(result.markdown).toBe('# Title');
    });

    test('should reject content without pattern or markdown', () => {
      expect(() => ContentSchema.parse({ rationale: 'because' })).toThrow();
    });

    test('should reject content without rationale', () => {
      expect(() => ContentSchema.parse({ pattern: 'some' })).toThrow();
    });
  });

  describe('ReasoningSchema', () => {
    test('should accept valid reasoning', () => {
      const result = ReasoningSchema.parse({
        whyStandard: 'Industry best practice',
        sources: ['doc.md'],
        confidence: 0.9,
      });
      expect(result.whyStandard).toBe('Industry best practice');
      expect(result.confidence).toBe(0.9);
    });

    test('should reject empty sources', () => {
      expect(() =>
        ReasoningSchema.parse({
          whyStandard: 'x',
          sources: [],
          confidence: 0.5,
        })
      ).toThrow();
    });

    test('should reject confidence out of range', () => {
      expect(() =>
        ReasoningSchema.parse({
          whyStandard: 'x',
          sources: ['a'],
          confidence: 1.5,
        })
      ).toThrow();
    });
  });

  describe('Field schemas', () => {
    test('IdField should reject empty string', () => {
      expect(() => IdField.parse('')).toThrow();
      expect(IdField.parse('abc')).toBe('abc');
    });

    test('TitleField should reject empty string', () => {
      expect(() => TitleField.parse('')).toThrow();
    });

    test('LanguageField should reject empty string', () => {
      expect(() => LanguageField.parse('')).toThrow();
    });
  });
});

describe('Integration: Zod Schemas — mcp-tools.ts', () => {
  describe('HealthInput', () => {
    test('should accept empty object', () => {
      expect(HealthInput.parse({})).toEqual({});
    });
  });

  describe('SearchInput', () => {
    test('should apply defaults', () => {
      const result = SearchInput.parse({ query: 'auth' });
      expect(result.query).toBe('auth');
      expect(result.operation).toBe('search');
      expect(result.mode).toBe('auto');
      expect(result.kind).toBe('all');
      expect(result.limit).toBe(10);
    });

    test('should reject empty query', () => {
      expect(() => SearchInput.parse({ query: '' })).toThrow();
    });

    test('should reject invalid mode', () => {
      expect(() => SearchInput.parse({ query: 'x', mode: 'invalid' })).toThrow();
    });

    test('should accept optional fields', () => {
      const result = SearchInput.parse({
        query: 'test',
        keywords: ['runtime'],
        language: 'typescript',
        sessionId: 'sess-1',
        hostDeclaredIntent: {
          query: 'host query',
          keywords: ['intent'],
          sourceRefs: ['host:intent'],
        },
        hostTurnMeta: {
          threadId: 'raw-thread-id',
        },
      });
      expect(result.language).toBe('typescript');
      expect(result.keywords).toEqual(['runtime']);
      expect(result.hostDeclaredIntent?.sourceRefs).toEqual(['host:intent']);
      expect(result.hostTurnMeta?.threadId).toBe('raw-thread-id');
    });

    test('should accept ref-driven get/expand operations without query', () => {
      const result = SearchInput.parse({
        operation: 'expand',
        refId: 'knowledge:contract',
      });

      expect(result.operation).toBe('expand');
      expect(result.refId).toBe('knowledge:contract');
    });
  });

  describe('KnowledgeInput', () => {
    test('should default to list operation', () => {
      const result = KnowledgeInput.parse({});
      expect(result.operation).toBe('list');
    });

    test('should require id for get operation', () => {
      expect(() => KnowledgeInput.parse({ operation: 'get' })).toThrow();
    });

    test('should accept get with id', () => {
      const result = KnowledgeInput.parse({ operation: 'get', id: 'k-1' });
      expect(result.id).toBe('k-1');
    });
  });

  describe('StructureInput', () => {
    test('should apply defaults', () => {
      const result = StructureInput.parse({});
      expect(result.operation).toBe('targets');
      expect(result.includeSummary).toBe(true);
      expect(result.includeContent).toBe(false);
    });
  });

  describe('GraphInput', () => {
    test('should default to project graph query operation', () => {
      const result = GraphInput.parse({});

      expect(result.operation).toBe('query');
      expect(result.direction).toBe('both');
      expect(result.detailLevel).toBe('summary');
    });

    test('should accept valid operation', () => {
      const result = GraphInput.parse({ operation: 'stats' });
      expect(result.direction).toBe('both');
      expect(result.maxDepth).toBe(2);
    });

    test('should reject recipe graph semantics', () => {
      expect(GraphInput.safeParse({ nodeType: 'recipe' }).success).toBe(false);
      expect(GraphInput.safeParse({ nodeType: 'knowledge' }).success).toBe(false);
      expect(GraphInput.safeParse({ relation: 'coveredByKnowledge' }).success).toBe(false);
    });
  });

  describe('GuardInput', () => {
    test('should accept empty input', () => {
      const result = GuardInput.parse({});
      expect(result).toBeDefined();
    });

    test('should accept code + language', () => {
      const result = GuardInput.parse({ code: 'console.log("x")', language: 'js' });
      expect(result.code).toBe('console.log("x")');
    });
  });

  describe('SubmitKnowledgeInput', () => {
    test('should accept bootstrap session fields used by the evidence gate route', () => {
      const result = SubmitKnowledgeInput.parse({
        dimensionId: 'architecture',
        sessionId: 'session-1',
        bootstrapSessionRef: 'session-1',
        skipConsolidation: true,
        items: [
          {
            title: 'Source Bound Fact',
            sourceRefs: ['package.json:1'],
          },
        ],
      });

      expect(result.sessionId).toBe('session-1');
      expect(result.bootstrapSessionRef).toBe('session-1');
      expect(result.dimensionId).toBe('architecture');
    });
  });

  describe('TaskInput', () => {
    test('should require operation', () => {
      expect(() => TaskInput.parse({})).toThrow();
    });

    test('should accept create with title', () => {
      const result = TaskInput.parse({ operation: 'create', title: 'Fix bug' });
      expect(result.operation).toBe('create');
      expect(result.title).toBe('Fix bug');
    });

    test('should accept close with id, reason, and task-scoped file refs', () => {
      const result = TaskInput.parse({
        operation: 'close',
        id: 'asd-123',
        reason: 'done',
        changedFiles: ['lib/runtime/mcp/handlers/task.ts'],
        sourceRefs: ['lib/service/task/TaskLifecyclePolicy.ts'],
      });
      expect(result.operation).toBe('close');
      expect(result.id).toBe('asd-123');
      expect(result.changedFiles).toEqual(['lib/runtime/mcp/handlers/task.ts']);
      expect(result.sourceRefs).toEqual(['lib/service/task/TaskLifecyclePolicy.ts']);
    });

    test('should accept all valid operations', () => {
      const ops = ['prime', 'create', 'close', 'fail', 'record_decision'];
      for (const op of ops) {
        expect(TaskInput.parse({ operation: op }).operation).toBe(op);
      }
    });

    test('should accept host intent and turn metadata while stripping unknown payload', () => {
      const result = TaskInput.parse({
        operation: 'prime',
        hostDeclaredIntent: {
          summary: 'Route host intent into prime',
          confidence: 0.6,
          labels: ['intent'],
          sourceRefs: ['host:intent'],
          hugePayload: 'strip me',
        },
        hostTurnMeta: {
          threadId: 'raw-thread-id',
          messageId: 'message-1',
          projectRoot: '/Users/private/project',
        },
      });

      expect(result.hostDeclaredIntent?.summary).toBe('Route host intent into prime');
      expect(result.hostDeclaredIntent?.confidence).toBe(0.6);
      expect(result.hostDeclaredIntent?.sourceRefs).toEqual(['host:intent']);
      expect(result.hostTurnMeta?.threadId).toBe('raw-thread-id');
      expect(result.hostTurnMeta?.messageId).toBe('message-1');
      expect(Object.hasOwn(result.hostDeclaredIntent ?? {}, 'hugePayload')).toBe(false);
      expect(Object.hasOwn(result.hostTurnMeta ?? {}, 'projectRoot')).toBe(false);
    });
  });

  describe('TOOL_SCHEMAS mapping', () => {
    test('should have schema for every MCP tool', () => {
      const expectedTools = [
        'alembic_health',
        'alembic_search',
        'alembic_knowledge',
        'alembic_structure',
        'alembic_graph',
        'alembic_call_context',
        'alembic_guard',
        'alembic_submit_knowledge',
        'alembic_project_skill',
        'alembic_bootstrap',
        'alembic_dimension_complete',
        'alembic_knowledge_lifecycle',
      ];
      for (const tool of expectedTools) {
        expect(TOOL_SCHEMAS[tool]).toBeDefined();
        expect(TOOL_SCHEMAS[tool]).toBeInstanceOf(z.ZodType);
      }
    });

    test('should have at least 13 entries', () => {
      expect(Object.keys(TOOL_SCHEMAS).length).toBeGreaterThanOrEqual(12);
      expect(TOOL_SCHEMAS).not.toHaveProperty('alembic_enrich_candidates');
    });
  });
});

describe('Integration: Zod Schemas — http-requests.ts', () => {
  describe('CreateKnowledgeBody', () => {
    test('should accept minimal valid input', () => {
      const result = CreateKnowledgeBody.parse({
        title: 'My Pattern',
        content: 'Some content',
      });
      expect(result.title).toBe('My Pattern');
    });

    test('should accept object content', () => {
      const result = CreateKnowledgeBody.parse({
        title: 'Test',
        content: { pattern: 'x', markdown: 'y' },
      });
      expect(result.content).toEqual({ pattern: 'x', markdown: 'y' });
    });

    test('should reject empty title', () => {
      expect(() => CreateKnowledgeBody.parse({ title: '', content: 'x' })).toThrow();
    });

    test('should reject empty string content', () => {
      expect(() => CreateKnowledgeBody.parse({ title: 'x', content: '' })).toThrow();
    });
  });

  describe('UpdateKnowledgeBody', () => {
    test('should accept partial updates', () => {
      const result = UpdateKnowledgeBody.parse({ title: 'New Title' });
      expect(result.title).toBe('New Title');
    });

    test('should reject empty object', () => {
      expect(() => UpdateKnowledgeBody.parse({})).toThrow();
    });
  });

  describe('BatchPublishBody', () => {
    test('should accept array of ids', () => {
      const result = BatchPublishBody.parse({ ids: ['a', 'b', 'c'] });
      expect(result.ids).toHaveLength(3);
    });

    test('should reject empty ids array', () => {
      expect(() => BatchPublishBody.parse({ ids: [] })).toThrow();
    });

    test('should reject empty string in ids', () => {
      expect(() => BatchPublishBody.parse({ ids: [''] })).toThrow();
    });
  });

  describe('SearchQuery', () => {
    test('should require query string', () => {
      expect(() => SearchQuery.parse({ q: '' })).toThrow();
    });

    test('should apply defaults', () => {
      const result = SearchQuery.parse({ q: 'auth' });
      expect(result.type).toBe('all');
      expect(result.mode).toBe('keyword');
    });
  });

  describe('AuthLoginBody', () => {
    test('should require username and password', () => {
      expect(() => AuthLoginBody.parse({})).toThrow();
      expect(() => AuthLoginBody.parse({ username: 'admin' })).toThrow();
    });

    test('should accept valid credentials', () => {
      const result = AuthLoginBody.parse({ username: 'admin', password: 'pass' });
      expect(result.username).toBe('admin');
    });
  });
});

describe('Integration: Zod Schemas — config.ts', () => {
  describe('AppConfigSchema', () => {
    test('should accept empty config (all optional)', () => {
      const result = AppConfigSchema.parse({});
      expect(result).toBeDefined();
    });

    test('should accept full config', () => {
      const result = AppConfigSchema.parse({
        database: { type: 'sqlite', path: './test.db' },
        server: { port: 8080, host: '0.0.0.0' },
        logging: { level: 'debug', console: true },
      });
      expect(result.database?.type).toBe('sqlite');
      expect(result.server?.port).toBe(8080);
    });

    test('should reject invalid port', () => {
      expect(() =>
        AppConfigSchema.parse({
          server: { port: 99999 },
        })
      ).toThrow();
    });

    test('should reject invalid log level', () => {
      expect(() =>
        AppConfigSchema.parse({
          logging: { level: 'verbose' },
        })
      ).toThrow();
    });

    test('should allow passthrough fields', () => {
      const result = AppConfigSchema.parse({ customField: 'value' });
      expect((result as Record<string, unknown>).customField).toBe('value');
    });
  });

  describe('Compatibility policy schema', () => {
    test('should accept empty compatibility policy', () => {
      const result = ConstitutionSchema.parse({});
      expect(result.rules).toEqual([]);
      expect(result.capabilities).toEqual({});
    });

    test('should accept valid entrypoint safety policy', () => {
      const result = ConstitutionSchema.parse({
        version: '4.0',
        rules: [{ id: 'destructive_confirm', check: 'destructive_needs_confirmation' }],
      });
      expect(result.rules).toHaveLength(1);
      expect(result.roles).toEqual([]);
    });

    test('should reject rule without id', () => {
      expect(() =>
        ConstitutionSchema.parse({
          rules: [{ check: 'something' }],
        })
      ).toThrow();
    });

    test('keeps retired role arrays empty for Plugin policy files', () => {
      const result = ConstitutionSchema.parse({ roles: [] });
      expect(result.roles).toEqual([]);
    });
  });
});
