import { expect, test, vi } from "vitest"
import type { Session } from "@merakcode/sdk/client"
import { session, setPermissionLevel, setState } from "./store"

const requests: { url: string; method?: string }[] = []
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (url: string, init?: { method?: string }) => {
    requests.push({ url, method: init?.method })
    return url.includes("/permission-level")
      ? Response.json({ code: "MRK-4012", message: "The permission level changed" }, { status: 409 })
      : Response.json({
          id: "permission-root",
          directory: "/work",
          projectID: "project",
          title: "Root",
          slug: "root",
          version: "0.3.0",
          time: { created: 0, updated: 4 },
          permissionLevel: "fullTakeover",
          permissionRevision: 4,
        })
  },
}))

test("a permission conflict reloads the authoritative root selection without retrying the old choice", async () => {
  setState("sessions", "session", [
    { id: "permission-child", parentID: "permission-root", directory: "/work" } as Session,
    { id: "permission-root", directory: "/work", permissionLevel: "ask", permissionRevision: 0 } as Session,
  ])
  try {
    await expect(setPermissionLevel("permission-child", "/work", "autoApprove")).rejects.toMatchObject({
      code: "MRK-4012",
    })
    expect(session("permission-root")).toMatchObject({ permissionLevel: "fullTakeover", permissionRevision: 4 })
    expect(requests.filter((request) => request.url.includes("/permission-level"))).toHaveLength(1)
    expect(requests.some((request) => request.url.includes("/session/permission-root"))).toBe(true)
  } finally {
    setState("sessions", "session", [])
  }
})
