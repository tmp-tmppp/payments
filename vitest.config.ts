import { defineConfig } from "vitest/config";

// Unit tests need no network and no Docker. The Testcontainers tests live in tests/integration and run with
// "npm run test:integration" (vitest.integration.config.ts).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
    reporters: ["default", "junit"],
    outputFile: { junit: "reports/junit.xml" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Excluded: the composition root, interface-only files and the adapters that need real infrastructure
      // (they are covered by the integration tests or by the real broker).
      exclude: ["src/main.ts", "src/usecases/ports.ts", "src/adapters/postgres/**", "src/adapters/nats/**"],
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: { lines: 80, functions: 80, statements: 80 },
    },
  },
});
