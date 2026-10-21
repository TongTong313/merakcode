import { config } from "../../script/node/vitest.ts"

// test/sequences: end-to-end tests that start a real backend and a local fake model server and drive them through the
// SDK, blocking every non-local request in process. Slow, so they stay out of pnpm test; run them with
// pnpm test:e2e [file]
export default config({
  include: ["test/sequences/**/*.test.ts"],
  setupFiles: ["./test/preload.ts"],
  testTimeout: 600_000,
  hookTimeout: 120_000,
  // Each sequence starts its own backend and model server; running serially avoids port conflicts
  maxWorkers: 1,
})
