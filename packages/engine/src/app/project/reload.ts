import { Instance } from "../../infra/project/instance"
import { WorkflowState } from "../task/workflow/state"

/** Disposes project instances after config changes without interrupting active workflows. */
export namespace ProjectReload {
  export async function instance(invalidate: () => void) {
    if (!WorkflowState.hasActive()) {
      await Instance.dispose()
      return
    }
    invalidate()
    // The deferred callback runs outside the Instance context, so capture and restore the directory.
    const directory = Instance.directory
    WorkflowState.requestReloadWhenIdle(() => void Instance.provide({ directory, fn: () => Instance.dispose() }))
  }

  export async function all(invalidateAll: () => void) {
    // A global update can arrive without an Instance context. In that case, dispose every instance now.
    // Known limit: hasActive sees only the current instance, so another project's workflow may be disposed.
    if (!Instance.has() || !WorkflowState.hasActive()) {
      await Instance.disposeAll().catch(() => undefined)
      return
    }
    invalidateAll()
    WorkflowState.requestReloadWhenIdle(() => void Instance.disposeAll().catch(() => undefined))
  }
}
