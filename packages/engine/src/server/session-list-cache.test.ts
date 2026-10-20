import { describe, expect, test } from "vitest"
import { createSessionListCache, shouldInvalidateSessionListCache } from "./session-list-cache"

describe("createSessionListCache", () => {
  test("reuses the cached value within the TTL without loading again", async () => {
    let loads = 0
    const cache = createSessionListCache({
      ttlMs: 5_000,
      load: async () => {
        loads += 1
        return ["a"]
      },
    })

    expect(await cache.get()).toEqual(["a"])
    expect(await cache.get()).toEqual(["a"])
    expect(loads).toBe(1)
  })

  test("loads again on the next get after invalidate", async () => {
    let loads = 0
    const cache = createSessionListCache({
      ttlMs: 5_000,
      load: async () => {
        loads += 1
        return loads
      },
    })

    expect(await cache.get()).toBe(1)
    cache.invalidate()
    expect(await cache.get()).toBe(2)
    expect(loads).toBe(2)
  })

  test("loads again after the TTL expires", async () => {
    let loads = 0
    let now = 1_000
    const realNow = Date.now
    Date.now = () => now
    try {
      const cache = createSessionListCache({
        ttlMs: 100,
        load: async () => {
          loads += 1
          return loads
        },
      })

      expect(await cache.get()).toBe(1)
      now = 1_050
      expect(await cache.get()).toBe(1)
      now = 1_200
      expect(await cache.get()).toBe(2)
      expect(loads).toBe(2)
    } finally {
      Date.now = realNow
    }
  })
})

describe("shouldInvalidateSessionListCache", () => {
  test("only session create, update and delete events invalidate", () => {
    expect(shouldInvalidateSessionListCache("session.created")).toBe(true)
    expect(shouldInvalidateSessionListCache("session.updated")).toBe(true)
    expect(shouldInvalidateSessionListCache("session.deleted")).toBe(true)
    expect(shouldInvalidateSessionListCache("message.updated")).toBe(false)
    expect(shouldInvalidateSessionListCache(undefined)).toBe(false)
  })
})
