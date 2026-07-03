import { homedir } from 'node:os';

// Codex stdio 启动时可能遇到 stale cwd，fallback 必须保持不会抛错。
export function safeProjectRootFallback(): string {
  try {
    return process.cwd();
  } catch {
    return process.env.PWD || homedir();
  }
}
