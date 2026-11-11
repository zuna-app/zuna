import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The same test server the core's tests build, once for the run.
    globalSetup: ["../../packages/core/test/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    maxWorkers: 1,
    // Only with --coverage, as `npm run test:coverage` and the Coverage workflow run it. Paths are written from
    // the repository's root, as Codecov reads them.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", ["lcov", { projectRoot: "../.." }]],
      reportsDirectory: "../../coverage/bot",
    },
  },
});
