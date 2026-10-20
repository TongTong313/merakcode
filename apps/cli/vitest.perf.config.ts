import { config } from "../../script/node/vitest.ts"

// test/perf: starts a real backend to measure latency and memory. Run in parallel with other tests it would measure
// machine load, so it stays out of pnpm test and runs serially on its own: pnpm test:perf
export default config({
  include: ["test/perf/**/*.test.ts"],
  setupFiles: ["./test/preload.ts"],
  maxWorkers: 1,
})
