import { expect, test, vi } from "vitest"
import { buffersFor, releaseBuffers } from "./state"
import { readDraft } from "./draft"
import { updateCheckout } from "../../state/git"

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
let failRead = false
const saves: string[] = []
let identityPause: { entered: () => void; resumed: Promise<void> } | undefined
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (input: string, init?: { method?: string; body?: ArrayBuffer; headers?: HeadersInit }) => {
    if (init?.method === "PUT") saves.push(new TextDecoder().decode(init.body))
    const url = new URL(input)
    const directory = decodeURIComponent(new Headers(init?.headers).get("x-merakcode-directory") ?? "/plan-save-race")
    if (url.pathname === "/file/identity") {
      identityPause?.entered()
      await identityPause?.resumed
      return Response.json({ directory, path: url.searchParams.get("path") })
    }
    if (failRead && !url.pathname.includes("/vcs/") && init?.method !== "PUT" && gets++ > 0)
      return new Response("unavailable", { status: 503 })
    const data = url.pathname.includes("/vcs/")
      ? { directory, branches: [], current: { checkout: "main", branch: "main", head: "head" } }
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

test("closing a file while its identity loads does not reopen its buffer", async () => {
  const buffer = buffersFor("/identity-close")
  const entered = Promise.withResolvers<void>()
  const resumed = Promise.withResolvers<void>()
  identityPause = { entered: () => entered.resolve(), resumed: resumed.promise }
  const opening = buffer.open("notes.txt")
  try {
    await entered.promise
    await buffer.close("notes.txt")
    resumed.resolve()
    await opening
    expect(buffer.tabs).toHaveLength(0)
  } finally {
    resumed.resolve()
    identityPause = undefined
    await opening
    releaseBuffers("/identity-close")
  }
})

test("checkout changes do not mark another case-sensitive worktree draft as conflicted", async () => {
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel")
  const first = buffersFor("/CaseRoots/Repo")
  const second = buffersFor("/CaseRoots/repo")
  try {
    await first.open("notes.txt")
    await second.open("notes.txt")
    second.tabs[0]!.model!.setValue("independent draft")
    updateCheckout("/CaseRoots/Repo", { checkout: "next", branch: "next", head: "next" }, true)
    await first.reload(true)
    expect(second.tabs[0]?.conflict).toBeFalsy()
    expect(second.tabs[0]?.model?.getValue()).toBe("independent draft")
    await second.close("notes.txt")
  } finally {
    releaseBuffers("/CaseRoots/Repo")
    releaseBuffers("/CaseRoots/repo")
    platform.mockRestore()
  }
})

test("plans and physical files with the same display name keep separate buffers and drafts", async () => {
  const buffer = buffersFor("/plan-file-collision")
  try {
    await buffer.open("Plan-ses_race.md")
    await buffer.open("Plan-ses_race.md", "ses_race")
    expect(buffer.tabs).toHaveLength(2)
    const file = buffer.tabs.find((tab) => !tab.planSessionID)!
    const plan = buffer.tabs.find((tab) => !!tab.planSessionID)!
    file.model!.setValue("Physical draft")
    plan.model!.setValue("Official plan draft")
    await buffer.suspend(file.path, "file")
    await buffer.suspend(plan.path, "plan")
    expect(await readDraft("/plan-file-collision", file.path)).toMatchObject({ content: "Physical draft" })
    expect(await readDraft("/plan-file-collision", plan.path)).toMatchObject({ content: "Official plan draft" })
    await buffer.close(file.path)
    await buffer.close(plan.path)
  } finally {
    releaseBuffers("/plan-file-collision")
  }
})

test("execution refuses to continue when a persisted plan draft cannot be loaded", async () => {
  const buffer = buffersFor("/plan-read-failure")
  try {
    await buffer.open("Plan-ses_race.md", "ses_race")
    const path = buffer.tabs[0]!.path
    buffer.tabs[0]!.model!.setValue("Do not execute the old plan")
    await buffer.suspend(path, "view")
    gets = 0
    failRead = true
    expect(await buffer.savePlan("ses_race")).toBe(false)
    expect(await readDraft("/plan-read-failure", path)).toMatchObject({ content: "Do not execute the old plan" })
    await buffer.close(path)
  } finally {
    failRead = false
    releaseBuffers("/plan-read-failure")
  }
})

test("aliases use one buffer and retain recoverable draft content", async () => {
  const buffer = buffersFor("/buffer-alias")
  try {
    await buffer.open("src/../notes.txt")
    await buffer.open("notes.txt")
    expect(buffer.tabs).toHaveLength(1)
    buffer.tabs[0]!.model!.setValue("Alias draft")
    await buffer.suspend("./notes.txt", "view")
    expect(buffer.tabs).toHaveLength(0)
    expect(await readDraft("/buffer-alias", "notes.txt")).toMatchObject({ content: "Alias draft" })
    await buffer.close("notes.txt")
  } finally {
    releaseBuffers("/buffer-alias")
  }
})

test("starting a root plan saves a suspended child editor through its owning session", async () => {
  const buffer = buffersFor("/child-plan")
  try {
    await buffer.open("Plan-child.md", "ses_child")
    const path = buffer.tabs[0]!.path
    buffer.tabs[0]!.model!.setValue("Child human plan")
    await buffer.suspend(path, "view")
    const before = saves.length
    expect(await buffer.savePlan("ses_race")).toBe(true)
    expect(saves.slice(before).some((body) => JSON.parse(body).content === "Child human plan")).toBe(true)
  } finally {
    releaseBuffers("/child-plan")
  }
})

test("executing a plan saves the editor draft after its view has unmounted", async () => {
  const buffer = buffersFor("/suspended-plan")
  try {
    await buffer.open("Plan-ses_race.md", "ses_race")
    buffer.tabs[0]!.model!.setValue("Suspended human plan")
    await buffer.suspend(buffer.tabs[0]!.path, "view")
    expect(buffer.tabs).toHaveLength(0)
    const before = saves.length
    expect(await buffer.savePlan("ses_race")).toBe(true)
    expect(saves.slice(before).some((body) => JSON.parse(body).content === "Suspended human plan")).toBe(true)
  } finally {
    releaseBuffers("/suspended-plan")
  }
})

test("saving a plan keeps its response revision paired with the submitted content", async () => {
  gets = 0
  const buffer = buffersFor("/plan-save-race")
  try {
    await buffer.open("/plan.md", "ses_race")
    buffer.tabs[0]!.model!.setValue("Human A")
    await buffer.save(false, buffer.tabs[0]!.path)
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
