import { config } from "../../script/node/vitest.ts"

export default config({
  include: ["test/**/*.test.ts"],
  // test/sequences are slow end-to-end tests with real processes (pnpm test:e2e); test/perf measures performance
  // (pnpm test:perf)
  exclude: ["test/sequences/**", "test/perf/**", "**/node_modules/**"],
  setupFiles: ["./test/preload.ts"],
})
