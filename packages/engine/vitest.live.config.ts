import { defineConfig } from "vitest/config"
import base from "./vitest.config.ts"

// test/live calls real model APIs (needs their API keys), so it stays out of the normal suite and only runs on request.
// No mergeConfig: it concatenates the exclude arrays, which would still exclude test/live
export default defineConfig({
  ...base,
  test: { ...base.test, include: ["test/live/**/*.test.ts"], exclude: ["**/node_modules/**"], testTimeout: 120_000 },
})
