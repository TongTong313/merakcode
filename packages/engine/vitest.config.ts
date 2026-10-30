import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Concurrent Git processes and native watchers can exhaust Windows filesystem capacity before test deadlines.
    maxWorkers: process.platform === "win32" ? "50%" : undefined,
    projects: ["./vitest.engine.config.ts", "./vitest.sandbox.config.ts"],
  },
})
