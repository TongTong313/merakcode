import { discoverProject } from "@merakcode/engine/app/project/discover"
import { InstanceBootstrap } from "../project/bootstrap"
import { Instance } from "../../infra/project/instance"

/** Runs `fn` inside a fully bootstrapped project instance and disposes it afterwards */
export async function withInstance<T>(directory: string, fn: () => Promise<T>) {
  return Instance.provide({
    resolveProject: discoverProject,
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
