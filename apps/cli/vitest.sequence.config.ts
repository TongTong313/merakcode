import { config } from "../../script/node/vitest.ts"
import { solid } from "../../script/node/vitest-solid.ts"

// test/sequences: end-to-end tests that start a real backend, the terminal UI (in a PTY) and a local fake model
// server, blocking every non-local request in process. Slow (tens of seconds each), so they stay out of pnpm test;
// run them with pnpm test:e2e [file]
export default config(
  {
    include: ["test/sequences/**/*.test.ts"],
    setupFiles: ["./test/preload.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    // Each sequence starts its own backend and model server; running serially avoids port conflicts
    maxWorkers: 1,
  },
  [solid()],
)
