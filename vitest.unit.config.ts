import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['test/unit/**/*.test.ts'],
      exclude: ['test/integration/**', 'test/e2e/**', '**/node_modules/**', '**/.git/**'],
      // Several unit fixtures intentionally exercise real Git, SQLite, and filesystem paths.
      // Keep file-level parallelism while reserving CPU for their child processes and I/O.
      maxWorkers: 2,
      testTimeout: 10_000,
      hookTimeout: 10_000,
      teardownTimeout: 5_000,
    },
  })
);
