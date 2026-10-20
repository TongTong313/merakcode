import path from "path"
import { Global } from "../global"
import z from "zod"
import fs from "fs/promises"
import { Filesystem } from "@merakcode/util/filesystem"

export const OAUTH_DUMMY_KEY = "merakcode-oauth-dummy-key"

export namespace Auth {
  export const Oauth = z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
      accountId: z.string().optional(),
      enterpriseUrl: z.string().optional(),
    })
    .meta({ ref: "OAuth" })

  export const Api = z
    .object({
      type: z.literal("api"),
      key: z.string(),
    })
    .meta({ ref: "ApiAuth" })

  export const WellKnown = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
    })
    .meta({ ref: "WellKnownAuth" })

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown]).meta({ ref: "Auth" })
  export type Info = z.infer<typeof Info>

  export function create(filepath: string) {
    let writes = Promise.resolve()

    async function all(): Promise<Record<string, Info>> {
      const file = filepath
      const data = await Filesystem.readJson(file).catch(() => ({}) as Record<string, unknown>)
      return Object.entries(data).reduce(
        (acc, [key, value]) => {
          const parsed = Info.safeParse(value)
          if (!parsed.success) return acc
          acc[key] = parsed.data
          return acc
        },
        {} as Record<string, Info>,
      )
    }

    async function get(providerID: string) {
      const auth = await all()
      return auth[providerID]
    }

    function update(change: (data: Record<string, Info>) => void) {
      const pending = writes.then(async () => {
        const data = await all()
        change(data)
        await fs.mkdir(path.dirname(filepath), { recursive: true })
        await fs.writeFile(filepath, JSON.stringify(data, null, 2), { mode: 0o600 })
        await fs.chmod(filepath, 0o600).catch(() => {})
      })
      writes = pending.catch(() => undefined)
      return pending
    }

    function set(key: string, info: Info) {
      return update((data) => {
        data[key] = info
      })
    }

    function remove(key: string) {
      return update((data) => {
        delete data[key]
      })
    }

    return { get, all, set, remove }
  }

  /** Local credentials file */
  export const file = path.join(Global.Path.data, "auth.json")
  const runtime = create(file)

  export function get(providerID: string) {
    return runtime.get(providerID)
  }

  export function all() {
    return runtime.all()
  }

  export function set(key: string, info: Info) {
    return runtime.set(key, info)
  }

  export function remove(key: string) {
    return runtime.remove(key)
  }
}
