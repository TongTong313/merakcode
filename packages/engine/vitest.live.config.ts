import { defineConfig } from "vitest/config"
import base from "./vitest.engine.config.ts"

// test/live calls real model APIs (needs their API keys), so it stays out of the normal suite and only runs on request.
// MERAKCODE_LIVE tells test/preload.ts to keep the *_API_KEY variables it clears for every other test.
// No mergeConfig: it concatenates the exclude arrays, which would still exclude test/live
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["test/live/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 120_000,
    env: { MERAKCODE_LIVE: "1" },
  },
})
