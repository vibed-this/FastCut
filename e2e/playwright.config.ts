import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  testMatch: ["**/*.e2e.ts"],
  reporter: [["list"]],
  timeout: 180_000,
  retries: 1,
  workers: 1,
  outputDir: "../test-results",
});
