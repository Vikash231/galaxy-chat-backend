import { defineConfig } from "vitest/config";

const TEST_DB = "postgresql://galaxy:galaxy@localhost:5433/galaxy_test";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    // DB tests share one database; run files one at a time so truncation never races.
    fileParallelism: false,
    env: {
      DATABASE_URL: TEST_DB,
      DIRECT_URL: TEST_DB,
      LOG_LEVEL: "error",
      CLERK_JWT_KEY: "test",
      FRONTEND_ORIGIN: "http://localhost:3001",
      TRIGGER_SECRET_KEY: "tr_test",
      OPENROUTER_API_KEY: "test",
      MAGICA_API_KEY: "test",
      MAGICA_MODE: "live",
      MAGICA_BASE_URL: "https://magica.test",
    },
  },
});
