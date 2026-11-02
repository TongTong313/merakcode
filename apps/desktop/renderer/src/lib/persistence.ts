import { bridge } from "./bridge"

/** Strict writes are used for recoverable user work; callers must retain memory when persistence fails. */
export const persistent = {
  get: async (bucket: string, key: string) =>
    bridge ? bridge.storageGet(bucket, key) : localStorage.getItem(`${bucket}:${key}`),
  set: async (bucket: string, key: string, value: string) => {
    if (bridge) await bridge.storageSet(bucket, key, value)
    else localStorage.setItem(`${bucket}:${key}`, value)
  },
  remove: async (bucket: string, key: string) => {
    if (bridge) await bridge.storageRemove(bucket, key)
    else localStorage.removeItem(`${bucket}:${key}`)
  },
}
