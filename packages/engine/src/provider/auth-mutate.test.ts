import { describe, expect, test } from "vitest"
import { connectProvider, disconnectProvider } from "./auth-mutate"
import type { Auth } from "../auth"

// Tests the contract that credential changes call invalidate; no fake cache, so the test does not just test a double.

describe("auth-mutate", () => {
  test("disconnect removes the credentials and invalidates the cache", async () => {
    const removed: string[] = []
    const effects: string[] = []
    await disconnectProvider("alibaba-cn", {
      remove: async (k) => void removed.push(k),
      invalidate: () => void effects.push("invalidate"),
      changed: async () => void effects.push("changed"),
    })
    expect(removed).toEqual(["alibaba-cn"])
    expect(effects).toEqual(["invalidate", "changed"])
  })

  test("connect writes the credentials and invalidates the cache", async () => {
    const written: Array<{ key: string; info: Auth.Info }> = []
    const effects: string[] = []
    const info = { type: "api", key: "k" } as Auth.Info
    await connectProvider("deepseek", info, {
      set: async (k, value) => void written.push({ key: k, info: value }),
      invalidate: () => void effects.push("invalidate"),
      changed: async () => void effects.push("changed"),
    })
    expect(written).toEqual([{ key: "deepseek", info }])
    expect(effects).toEqual(["invalidate", "changed"])
  })

  test("disconnect calls invalidate even when remove clears nothing", async () => {
    let invalidated = 0
    await disconnectProvider("deepseek", {
      remove: async () => {},
      invalidate: () => void invalidated++,
      changed: async () => {},
    })
    expect(invalidated).toBe(1)
  })

  test("a failed credential write neither invalidates the cache nor notifies clients", async () => {
    const effects: string[] = []
    await expect(
      connectProvider(
        "deepseek",
        { type: "api", key: "k" },
        {
          set: async () => {
            throw new Error("write failed")
          },
          invalidate: () => void effects.push("invalidate"),
          changed: async () => void effects.push("changed"),
        },
      ),
    ).rejects.toThrow("write failed")
    expect(effects).toEqual([])
  })
})
