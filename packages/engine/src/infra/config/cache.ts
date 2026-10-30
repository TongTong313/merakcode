import { AsyncLocalStorage } from "node:async_hooks"
import { lazy } from "@merakcode/util/lazy"
import { Instance } from "../project/instance"

/** Configuration loads share one process cache and one cache per workspace, with isolated diagnostics. */
export function configurationCache<G, S, W>(loadGlobal: () => Promise<G>, loadInstance: (warnings: W[]) => Promise<S>) {
  const context = new AsyncLocalStorage<W[]>()
  let globalWarnings: W[] = []
  const global = lazy(async () => {
    const warnings: W[] = []
    return context.run(warnings, async () => {
      try {
        return await loadGlobal()
      } finally {
        globalWarnings = warnings
      }
    })
  })
  const state = Instance.state(() => {
    const warnings: W[] = []
    return context.run(warnings, () => loadInstance(warnings))
  })
  return {
    global,
    state,
    get globalWarnings() {
      return globalWarnings
    },
    warn(warning: W) {
      context.getStore()?.push(warning)
    },
  }
}
