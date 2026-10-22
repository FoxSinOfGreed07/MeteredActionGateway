import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/kit/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'scenarios',
          include: ['test/scenarios/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/kit/global-setup.ts'],
          testTimeout: 300_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
