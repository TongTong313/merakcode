import { bridge } from "./bridge"
import { t } from "../i18n"
import { MerakCodeError } from "@merakcode/sdk/errors"

/** Storage transport errors stay available as causes, while callers receive a localized recovery error. */
async function read<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    throw new MerakCodeError({ code: "MRK-4019", message: t("panel.restoreError"), cause })
  }
}

async function write(operation: () => void | Promise<void>) {
  try {
    await operation()
  } catch (cause) {
    throw new MerakCodeError({ code: "MRK-4018", message: t("panel.persistError"), cause })
  }
}

/** Strict writes are used for recoverable user work; callers must retain memory when persistence fails. */
export const persistent = {
  buckets: (): Promise<string[]> =>
    read(() =>
      bridge ? bridge.storageBuckets() : [...new Set(Object.keys(localStorage).map((key) => key.split(":")[0]!))],
    ),
  entries: (bucket: string): Promise<[string, string][]> =>
    read(async () => {
      if (bridge) return bridge.storageEntries(bucket)
      return Object.keys(localStorage)
        .filter((key) => key.startsWith(`${bucket}:`))
        .map((key) => [key.slice(bucket.length + 1), localStorage.getItem(key)!])
    }),
  get: (bucket: string, key: string) =>
    read(() => (bridge ? bridge.storageGet(bucket, key) : localStorage.getItem(`${bucket}:${key}`))),
  set: (bucket: string, key: string, value: string) =>
    write(() => (bridge ? bridge.storageSet(bucket, key, value) : localStorage.setItem(`${bucket}:${key}`, value))),
  remove: (bucket: string, key: string) =>
    write(() => (bridge ? bridge.storageRemove(bucket, key) : localStorage.removeItem(`${bucket}:${key}`))),
}
