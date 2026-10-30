import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { projects: ["./vitest.engine.config.ts", "./vitest.sandbox.config.ts"] },
})
