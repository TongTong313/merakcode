import { defineConfig } from "vitest/config"
import { availableParallelism } from "node:os"
import engine from "./vitest.engine.config.ts"
import sandbox from "./vitest.sandbox.config.ts"

export default defineConfig({
  test: {
    // Concurrent Git processes and native watchers can exhaust Windows filesystem capacity before test deadlines.
    maxWorkers:
      process.platform === "win32" ? Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2))) : undefined,
    projects: [
      { ...engine, extends: true },
      { ...sandbox, extends: true },
    ],
  },
})
