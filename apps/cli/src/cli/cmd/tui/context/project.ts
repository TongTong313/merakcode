import { batch } from "solid-js"
import type { Path } from "@merakcode/sdk/client"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"

/**
 * ProjectProvider — single-directory context
 *
 * - Initializes directory immediately from sdk.directory (no waiting for bootstrap),
 *   so diagnostics and directory-scoped consumers have a value in all lifecycle phases.
 * - sync() fetches the latest path info from the server via sdk.client.path.get(),
 *   called by SyncProvider during bootstrap.
 */
export const { use: useProject, provider: ProjectProvider } = createSimpleContext({
  name: "Project",
  init: () => {
    const sdk = useSDK()
    const defaultPath = {
      state: "",
      config: "",
      data: "",
      worktree: "",
      home: "",
      /** Initialize immediately without waiting for bootstrap, so it is available at all lifecycle stages. */
      directory: sdk.directory ?? "",
    }
    const [store, setStore] = createStore({
      instance: {
        path: { ...defaultPath } satisfies Path,
      },
    })

    /**
     * Sync latest path info from the server.
     * Called by SyncProvider during bootstrap.
     */
    async function sync() {
      const path = await sdk.client.path.get()
      batch(() => {
        setStore("instance", "path", reconcile(path.data || defaultPath))
      })
    }

    return {
      data: store,
      /** Current directory path. Used for cross-directory diagnostics; event routing is keyed by sessionID. */
      directory() {
        return store.instance.path.directory
      },
      sync,
    }
  },
})
