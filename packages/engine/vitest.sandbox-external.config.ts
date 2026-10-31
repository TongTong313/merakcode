import { config } from "../../script/node/vitest.ts"

// Requires an explicitly supplied external TCP endpoint; never part of the offline CI gate.
export default config({ include: ["test/sandbox/external/**/*.test.ts"] })
