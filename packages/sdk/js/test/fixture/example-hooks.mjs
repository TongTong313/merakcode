// Loaded with --import when the examples run in tests: points their `@merakcode/sdk` at example-sdk.ts
import { registerHooks } from "node:module"

const sdk = new URL("./example-sdk.ts", import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@merakcode/sdk" && context.parentURL?.includes("/examples/"))
      return { url: sdk, shortCircuit: true }
    return next(specifier, context)
  },
})
