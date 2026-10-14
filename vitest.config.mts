import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Silence Powertools output during tests (no metrics flushed, no log noise).
    env: {
      POWERTOOLS_LOG_LEVEL: 'SILENT',
      POWERTOOLS_METRICS_DISABLED: 'true',
      POWERTOOLS_SERVICE_NAME: 'orders-api-test',
      POWERTOOLS_METRICS_NAMESPACE: 'ServerlessOrdersApiTest',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/handlers/**'],
      reporter: ['text', 'html'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          // Integration tests share one DynamoDB table and one Valkey instance.
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
