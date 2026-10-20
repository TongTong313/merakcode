import { config } from "../../script/node/vitest.ts"

export default config({
  include: ["src/**/*.test.ts", "test/**/*.test.ts", "test/**/*.test.tsx"],
  // test/live calls real model APIs and only runs explicitly (vitest.live.config.ts)
  exclude: ["test/live/**", "**/node_modules/**"],
  setupFiles: ["./test/preload.ts"],
})
