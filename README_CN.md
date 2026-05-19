# AlembicPlugin

AlembicPlugin 是 Alembic 的插件统一仓库。

当前仓库先承载从 `GxFn/Alembic` 迁出的 Codex 插件运行时和开发验证工具。后续其他宿主插件也放在 `plugins/` 下面，以子仓库形式接入，不再混入核心能力仓库。

## 仓库模型

- 根仓库：维护共享插件工具、channel 元数据、发布检查和集成验证。
- `plugins/alembic-codex`：Codex 插件子仓库。
- 后续插件：按 `plugins/<host-or-plugin-name>` 增加子仓库。

克隆时拉取子仓库：

```bash
git clone --recurse-submodules https://github.com/GxFn/AlembicPlugin.git
```

更新子仓库：

```bash
git submodule update --init --recursive
```

Git 支持嵌套子仓库。如果某个插件子仓库未来还有自己的 submodule，使用 recursive 更新即可一并初始化。

## Codex 插件

当前 Codex 插件仍位于 `plugins/alembic-codex`。根仓库暂时保留当前 Alembic Codex MCP 运行时，后续会随着三仓库拆分逐步收敛：

- `GxFn/AlembicPlugin`：插件统一仓库。
- `GxFn/Alembic`：独立全能力本地产品。
- `GxFn/AlembicCore`：共享核心能力，在插件和本地产品边界稳定后抽取。

完整发布、测试和推广方案见 `plugins/alembic-codex/RELEASE-PLAYBOOK.md`。

推荐验证链路：

```bash
npm run build
npm run prepare:codex-plugin-runtime
npm run verify:codex-channel
npm run verify:codex-plugin
npm run smoke:codex-plugin
```

Dashboard 前端源码、构建和服务不再由本仓库负责。Codex 插件只在本地
Alembic daemon 已明确提供 Dashboard 能力时交接 URL。

发布检查：

```bash
npm run release:codex-plugin
npm run release:codex-plugin:daemon
```
