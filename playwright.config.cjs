const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "./tests/e2e",
  testMatch: "*.spec.cjs",
  timeout: 45000,
  expect: { timeout: 10000 },
  workers: 1,
  reporter: "list",
  outputDir: "test-results",
  use: { trace: "retain-on-failure" },
});
