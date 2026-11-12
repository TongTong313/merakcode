import { afterEach, expect, test, vi } from "vitest"
import { persistent } from "./persistence"
import { summary } from "../state/error"

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

test.each(["set", "remove"] as const)(
  "a failed durable %s keeps the record and exposes its storage error code",
  async (operation) => {
    await persistent.set("draft-test", "notes.txt", "original draft")
    const cause = new Error("Storage unavailable")
    vi.spyOn(localStorage, operation === "set" ? "setItem" : "removeItem").mockImplementationOnce(() => {
      throw cause
    })
    const result = await (
      operation === "set"
        ? persistent.set("draft-test", "notes.txt", "next draft")
        : persistent.remove("draft-test", "notes.txt")
    ).catch((error: unknown) => error)
    expect(result).toMatchObject({ code: "MRK-4025", cause })
    expect(summary(result)).toBe("MRK-4025")
    expect(await persistent.get("draft-test", "notes.txt")).toBe("original draft")
  },
)
