import { bridge } from "./bridge"

/** Strict writes are used for recoverable user work; callers must retain memory when persistence fails. */
export const persistent = {
  buckets: async (): Promise<string[]> =>
    bridge ? bridge.storageBuckets() : [...new Set(Object.keys(localStorage).map((key) => key.split(":")[0]!))],
  entries: async (bucket: string): Promise<[string, string][]> => {
    if (bridge) return bridge.storageEntries(bucket)
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(`${bucket}:`))
      .map((key) => [key.slice(bucket.length + 1), localStorage.getItem(key)!])
  },
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
