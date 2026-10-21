import solid from "vite-plugin-solid"
import { config } from "../../../script/node/vitest.ts"

export default config(
  {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "happy-dom",
    css: true,
    // Let Vite resolve Solid (browser + dev build) so Node does not load a second copy natively
    server: { deps: { inline: [/solid-js/, /@solidjs\//, /@kobalte\//] } },
  },
  [solid({ hot: false })],
)
