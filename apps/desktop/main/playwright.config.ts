import { defineConfig } from "@playwright/test"

// Desktop end-to-end tests launch the real Electron app (see e2e/fixture.ts). Each test gets its own window and
// engine, so they run serially.
export default defineConfig({
  forbidOnly: !!process.env.CI,
  testDir: "./e2e",
  outputDir: "./e2e/.results",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
})
