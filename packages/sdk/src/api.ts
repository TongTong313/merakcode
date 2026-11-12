import { methodSchemas, type Methods } from "./protocol.gen"

/** Methods that need state of the connection (subscriptions, client tools, the greeting) and are written by hand. */
export const INTERNAL_METHODS = [
  "hello",
  "events.subscribe",
  "events.unsubscribe",
  "tool.register",
  "tool.unregister",
  "tool.result",
] as const

type Internal = (typeof INTERNAL_METHODS)[number]
type Public = Exclude<keyof Methods, Internal>
type Namespace<M extends string> = M extends `${infer N}.${string}` ? N : never
type Name<N extends string, M extends string> = M extends `${N}.${infer R}` ? R : never

/** A method whose parameters have no required field can be called without arguments. */
type Call<K extends keyof Methods> = {} extends Methods[K]["params"]
  ? (params?: Methods[K]["params"]) => Promise<Methods[K]["result"]>
  : (params: Methods[K]["params"]) => Promise<Methods[K]["result"]>

export type Api = {
  [N in Namespace<Public>]: { [R in Name<N, Public>]: Call<`${N}.${R}` & keyof Methods> }
}

export type Caller = <K extends keyof Methods>(method: K, params: Methods[K]["params"]) => Promise<Methods[K]["result"]>

/** Builds `api.namespace.name(params)` for every method of the protocol, so a method added to the protocol cannot be missed. */
export function createApi(call: Caller): Api {
  const api: Record<string, Record<string, unknown>> = {}
  for (const method of Object.keys(methodSchemas) as (keyof Methods)[]) {
    if ((INTERNAL_METHODS as readonly string[]).includes(method)) continue
    const [namespace, name] = (method as string).split(/\.(.*)/s) as [string, string]
    ;(api[namespace] ??= {})[name] = (params?: unknown) => call(method, (params ?? {}) as never)
  }
  return api as Api
}
