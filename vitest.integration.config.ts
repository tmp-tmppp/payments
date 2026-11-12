import { defineConfig } from "vitest/config";

// Tests against a real PostgreSQL 18 started by Testcontainers (needs a running Docker daemon).
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
