import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./src/setup.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Each file starts its own server and hosts; running them one at a time keeps timings honest.
    fileParallelism: false,
  },
});
