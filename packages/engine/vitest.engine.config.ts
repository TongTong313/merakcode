import { config } from "../../script/node/vitest.ts"

export default config({
  name: "engine",
  include: ["src/**/*.test.ts", "test/**/*.test.ts", "test/**/*.test.tsx"],
  exclude: [
    "test/live/**",
    "test/sandbox/external/**",
    "**/node_modules/**",
    "src/infra/sandbox/**/*.test.ts",
    "src/agent/permission/sandbox-policy.test.ts",
    "test/sandbox/os/**",
  ],
  setupFiles: ["./test/preload.ts"],
})
