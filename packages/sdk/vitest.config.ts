import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // The end-to-end tests start a real engine. Its first turn creates the snapshot repository and records the
    // workspace, which can take longer than the default one second of expect.poll on a cold or busy machine.
    expect: { poll: { timeout: 15_000 } },
  },
})
