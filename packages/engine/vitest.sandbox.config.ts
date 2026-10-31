import { config } from "../../script/node/vitest.ts"

// Real OS enforcement must use the installed sandbox, without the engine's sandbox-off preload.
export default config({
  name: "sandbox",
  include: [
    "src/infra/sandbox/**/*.test.ts",
    "src/agent/permission/sandbox-policy.test.ts",
    "test/sandbox/os/**/*.test.ts",
  ],
})
