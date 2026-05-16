# AlembicPlugin Agent Instructions

**重要**：本项目是 Alembic 的 Codex 插件与宿主集成仓库，不是用户项目环境。

Agent 不够聪明。

Agent 可以制定目标和计划，但目标和计划必须服务于用户提出的真实任务，不能被 Agent 自己偏好的“干净”“薄”“轻量”“空壳”“先搭框架”等路线替换。

Agent 不得把完整实现改成薄实现，不得把成熟能力改成空壳接口，不得把迁移、整理、重构、优化或插件化解释成削减功能。

当 Agent 的计划涉及删减、替换、降级、延期、只做部分、只搭框架、只保留接口、暂不接入或改变完整范围时，必须先向用户确认。

## 仓库定位

- `AlembicPlugin` 负责 Codex 插件、Codex MCP runtime、skills、marketplace/channel 发布、插件 smoke 和未来宿主插件集成。
- `@alembic/core` 通过 `vendor/AlembicCore` 接入；只有已经在 Core 中完整保真的共享能力才可以切换过去。
- Codex 主 Agent 能力属于宿主环境。本仓库负责把 Codex tool/skill/runtime 与 Alembic 能力连接起来，不要把插件适配层误删成 Core 内核。
- 不要在 `/Users/gaoxuefeng/Documents/github` 下的旧项目工作；当前统一使用 `/Users/gaoxuefeng/Documents/AlembicWorkspace`。

## 需要测试时

- 本地插件开发常用：
  - `npm run build`
  - `npm run build:check`
  - `npm run lint`
  - `npm run test:unit`
  - `npm run test:integration`
  - `npm run smoke:codex-plugin`
  - `npm run verify:codex-plugin`
  - `npm run verify:codex-session`
- 本地链接：`npm run dev:link`。
- Codex 插件同步/验证：
  - `npm run dev:codex-plugin:sync`
  - `npm run dev:codex-plugin:local-mcp`
  - `npm run dev:codex-plugin:verify`
- 不要在 AlembicPlugin 仓库内冒充用户项目执行真实用户命令。

## 文件存放约定

- 开发中的临时文档：`docs-dev/`（不跟随 git）。
- 临时测试脚本：`scratch/`（不跟随 git）。
- 正式文档：`docs/`（跟随 git）。
- 正式脚本：`scripts/` 或 `bin/`（跟随 git）。
- 插件资源：`plugins/`、`channels/`、`.agents/`、`injectable-skills/`。
- workspace 级迁移文档保存在 `/Users/gaoxuefeng/Documents/AlembicWorkspace/docs/`。

## 技术栈与编码约定

- 语言：TypeScript (ES2024, NodeNext)，Node.js >= 22。
- 模块系统：ESM (`"type": "module"`)，import 路径必须带 `.js` 后缀。
- 路径别名定义在 `package.json` imports 字段，当前包括：
  - `#shared/*`
  - `#infra/*`
  - `#service/*`
  - `#agent/*`
  - `#domain/*`
  - `#inject/*`
  - `#core/*`
  - `#external/*`
  - `#repo/*`
  - `#types/*`
  - `#http/*`
  - `#workflows/*`
  - `#tools/*`
  - `#codex/*`
- Lint / Format：Biome 2.x，不使用 Prettier/ESLint。
- 测试框架：Vitest。
- Dashboard：React + Vite，构建命令 `npm run build:dashboard`。

## Biome 关键规则

- `useConst`：不可变变量必须用 `const`。
- `useBlockStatements`：if/else/for/while 必须使用花括号。
- `useThrowOnlyError`：throw 只能抛出 Error 实例。
- `noVar`：禁止 `var`。
- `noDoubleEquals`：禁止 `==`、`!=`，使用 `===`、`!==`。
- `organizeImports`：import 必须按规则组织。

## 类型安全约定

- catch 块使用 `catch (err: unknown)` + 类型守卫，禁止 `catch (err: any)`。
- Dashboard 错误处理优先使用 `dashboard/src/utils/error.ts` 的工具函数。
- 避免 `as any`；不得已时加注释说明原因。
- MCP/Codex tool 返回结构必须保持明确 schema 和向后兼容。

## 架构层次

```text
lib/
├── agent
├── cli
├── codex
├── core
├── daemon
├── domain
├── external
├── http
├── infrastructure
├── injection
├── repository
├── service
├── shared
├── tools
├── types
└── workflows
```

## 子项目与资源

- `plugins/`：Codex 插件打包内容。
- `channels/`：Codex channel 发布内容。
- `.agents/`：插件 marketplace 元数据。
- `injectable-skills/`：Alembic skills。
- `dashboard/`：插件侧 Dashboard 前端。
- `vendor/AlembicCore`：Core 子仓库依赖。
