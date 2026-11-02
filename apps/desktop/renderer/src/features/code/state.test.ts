import { expect, test, vi } from "vitest"
import { buffersFor, releaseBuffers } from "./state"

vi.mock("../../lib/monaco", () => ({
  monaco: {
    Uri: { parse: (value: string) => value },
    editor: {
      createModel: (initial: string) => {
        let value = initial
        const listeners: Array<() => void> = []
        return {
          getValue: () => value,
          setValue: (next: string) => {
            value = next
            listeners.forEach((fn) => fn())
          },
          onDidChangeContent: (fn: () => void) => listeners.push(fn),
          dispose() {},
        }
      },
    },
  },
}))
let gets = 0
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (input: string, init?: { method?: string }) => {
    const url = new URL(input)
    const data = url.pathname.includes("/vcs/")
      ? { directory: "/plan-save-race", branches: [], current: { checkout: "main", branch: "main", head: "head" } }
      : {
          sessionID: "ses_race",
          path: "/plan.md",
          content: init?.method === "PUT" ? "Human A" : gets++ === 0 ? "Initial" : "Human B",
          revision: init?.method === "PUT" ? 1 : gets === 1 ? 0 : 2,
          humanRevision: 0,
          source: "human",
          status: "draft",
        }
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
  },
}))

test("saving a plan keeps its response revision paired with the submitted content", async () => {
  const buffer = buffersFor("/plan-save-race")
  try {
    await buffer.open("/plan.md", "ses_race")
    buffer.tabs[0]!.model!.setValue("Human A")
    await buffer.save(false, "/plan.md")
    expect(buffer.tabs[0]!.saved).toBe("Human A")
    expect(buffer.tabs[0]!.checksum).toBe("1")
    expect(buffer.tabs[0]!.dirty).toBe(false)
    await buffer.reload()
    expect(buffer.tabs[0]!.saved).toBe("Human B")
    expect(buffer.tabs[0]!.model!.getValue()).toBe("Human B")
    expect(buffer.tabs[0]!.checksum).toBe("2")
  } finally {
    releaseBuffers("/plan-save-race")
  }
})
