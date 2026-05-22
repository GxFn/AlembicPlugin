/**
 * SkillHooksModule — Codex plugin Skill lifecycle registration.
 *
 * AlembicPlugin 不再注册本地 agent runtime 或 terminal execution 服务；
 * 这里仅保留 Codex-facing SkillHooks，支撑插件模式下的 Skill 加载与生命周期闭环。
 */

import { SkillHooks } from '../../service/skills/SkillHooks.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  c.singleton('skillHooks', () => {
    const hooks = new SkillHooks();
    hooks.load().catch(() => {
      /* skill hooks load is best-effort */
    });
    return hooks;
  });
}
