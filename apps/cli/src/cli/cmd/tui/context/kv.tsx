import { Paths } from "@merakcode/util/paths"
import { createSignal, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Log } from "@merakcode/log/logger"

const log = Log.create({ source: "product", service: "tui.kv" })

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>()
    const file = path.join(Paths.state, "kv.json")

    Filesystem.readJson(file)
      .then((x) => {
        setStore(x)
      })
      .catch(() => {})
      .finally(() => {
        setReady(true)
      })

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name)
          },
          function setter(next: Setter<T>) {
            result.set(name, next)
          },
        ] as const
      },
      get(key: string, defaultValue?: any) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: any) {
        setStore(key, value)
        // A failed save only affects the next launch; the value is still used now.
        void Filesystem.write(file, JSON.stringify(store, null, 2)).catch((err) => {
          log.error("failed to save tui preferences", { err })
        })
      },
    }
    return result
  },
})
