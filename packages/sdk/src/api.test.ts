import { expect, it } from "vitest"
import { createApi, INTERNAL_METHODS } from "./api"
import { methodSchemas } from "./protocol.gen"

it("reaches every protocol method through a namespace, so no method is left without a typed wrapper", async () => {
  const called: string[] = []
  const api = createApi(async (method) => {
    called.push(method)
    return {} as never
  }) as unknown as Record<string, Record<string, (params?: unknown) => Promise<unknown>>>
  for (const method of Object.keys(methodSchemas)) {
    if (INTERNAL_METHODS.includes(method as never)) continue
    const [namespace, name] = method.split(/\.(.*)/s)
    expect(typeof api[namespace!]?.[name!], method).toBe("function")
    await api[namespace!]![name!]!({})
    expect(called.at(-1)).toBe(method)
  }
})

it("sends an empty object when a method that takes no required fields is called without arguments", async () => {
  const seen: unknown[] = []
  const api = createApi(async (_method, params) => {
    seen.push(params)
    return {} as never
  })
  await api.session.list()
  await api.config.get()
  expect(seen).toEqual([{}, {}])
})

it("keeps the methods that need local state out of the generic table", () => {
  expect(INTERNAL_METHODS).toEqual(
    expect.arrayContaining(["hello", "events.subscribe", "events.unsubscribe", "tool.register", "tool.unregister"]),
  )
})
