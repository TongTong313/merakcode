import { config } from "./node/vitest.ts"

// Tests for repository scripts (packaging, project info sync, etc.); run from the repository root: pnpm test:script
export default config({ include: ["script/**/*.test.ts"] })
