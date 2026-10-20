import { InstanceBootstrap } from "../project/bootstrap"
import { Instance } from "../project/instance"

/** Runs `fn` inside a fully bootstrapped project instance and disposes it afterwards */
export async function withInstance<T>(directory: string, fn: () => Promise<T>) {
  return Instance.provide({
    directory,
    init: InstanceBootstrap,
    fn: async () => {
      try {
        return await fn()
      } finally {
        await Instance.dispose()
      }
    },
  })
}
