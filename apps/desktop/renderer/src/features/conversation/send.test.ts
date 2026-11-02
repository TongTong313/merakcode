import { createServer } from "node:http"
import { afterEach, expect, test, vi } from "vitest"
import type { Session } from "@merakcode/sdk/client"
import { setState, setSessionMode } from "../../state/store"
import { choice } from "../../state/models"
import { applyEvent } from "@merakcode/sdk/store"
import { produce } from "solid-js/store"
import type { Event } from "@merakcode/sdk/client"
import { send } from "./send"
import { buffersFor, releaseBuffers } from "../code/state"

vi.mock("../../lib/monaco", () => ({
  monaco: {
    Uri: { parse: (value: string) => value },
    editor: {
      createModel: (initial: string) => {
        let value = initial
        const listeners: Array<() => void> = []
        return {
          getValue: () => value,
          setValue(next: string) {
            value = next
            listeners.forEach((listener) => listener())
          },
          onDidChangeContent: (listener: () => void) => listeners.push(listener),
          dispose() {},
        }
      },
    },
  },
}))

test("a child start message saves its unsaved root plan before submitting", async () => {
  const directory = "/child-plan-editor-start"
  let content = "APPROVED_A"
  let revision = 1
  const writes: string[] = []
  let submittedRevision: unknown
  let submittedPlan = ""
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
    response.setHeader("content-type", "application/json")
    if (request.url?.includes("/vcs/")) {
      response.end(
        JSON.stringify({ directory, branches: [], current: { checkout: "main", branch: "main", head: "head" } }),
      )
    } else if (request.url?.includes("/plan")) {
      if (request.method === "PUT") {
        writes.push(request.url)
        submittedRevision = body.expectedRevision
        content = body.content
        revision++
      }
      response.end(
        JSON.stringify({
          sessionID: "ses_editor_root",
          path: "/root-plan.md",
          content,
          revision,
          humanRevision: revision,
          source: "human",
          status: "draft",
        }),
      )
    } else {
      submittedPlan = content
      response.end("{}")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture did not listen")
  vi.stubGlobal("location", { origin: `http://127.0.0.1:${address.port}` })
  setState("sessions", "session", [
    { id: "ses_editor_child", parentID: "ses_editor_root", directory, sessionMode: "plan" } as Session,
    { id: "ses_editor_root", directory, sessionMode: "plan" } as Session,
  ])
  const buffer = buffersFor(directory)
  try {
    await buffer.open("/root-plan.md", "ses_editor_root")
    buffer.tabs[0]!.model!.setValue("LATEST_HUMAN_B")
    await send("ses_editor_child", directory, { text: "开始执行", files: [] })
    expect(writes).toHaveLength(1)
    expect(submittedRevision).toBe(1)
    expect(writes[0]).toContain("/session/ses_editor_root/plan")
    expect(submittedPlan).toBe("LATEST_HUMAN_B")
    expect(buffer.tabs[0]!.dirty).toBe(false)
  } finally {
    releaseBuffers(directory)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  setState("sessions", "session", [])
})

test.each([false, true])("a late HTTP mode reply preserves a newer root event (child %s)", async (child) => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const directory = `/late-mode-${child}`
  const root = {
    id: "ses_late_root",
    directory,
    time: { created: 1, updated: 1 },
    sessionMode: "execute",
    modeRevision: 0,
  } as Session
  const selected = child ? { ...root, id: "ses_late_child", parentID: root.id } : root
  setState("sessions", "session", child ? [selected, root] : [root])
  const server = createServer(async (_request, response) => {
    entered.resolve()
    await release.promise
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ ...selected, sessionMode: "plan", modeRevision: 1 }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture did not listen")
  vi.stubGlobal("location", { origin: `http://127.0.0.1:${address.port}` })
  try {
    const pending = setSessionMode(selected.id, directory, "plan")
    await entered.promise
    setState(
      "sessions",
      produce((draft) => {
        applyEvent(draft, {
          type: "session.updated",
          properties: { info: { ...root, sessionMode: "auto", modeRevision: 2 } },
        } as Event)
      }),
    )
    release.resolve()
    await pending
    expect(choice(root.id, directory).mode).toBe("auto")
    expect(choice(selected.id, directory).mode).toBe("auto")
  } finally {
    release.resolve()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("mode changes and the following message stay ordered without session events", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const modes: string[] = []
  let submissions = 0
  const directory = "/ordered-mode-send"
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
    response.setHeader("content-type", "application/json")
    if (request.url?.includes("/mode")) {
      modes.push(body.sessionMode)
      if (modes.length === 1) {
        entered.resolve()
        await release.promise
      }
      response.end(
        JSON.stringify({
          id: "ses_order_child",
          parentID: "ses_order_root",
          directory,
          time: { created: 1, updated: 1 },
          sessionMode: body.sessionMode,
          modeRevision: modes.length,
        }),
      )
    } else {
      submissions++
      response.end("{}")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture did not listen")
  vi.stubGlobal("location", { origin: `http://127.0.0.1:${address.port}` })
  setState("sessions", "session", [
    { id: "ses_order_child", parentID: "ses_order_root", directory, sessionMode: "auto" } as Session,
    { id: "ses_order_root", directory, sessionMode: "auto" } as Session,
  ])
  try {
    const first = setSessionMode("ses_order_child", directory, "execute")
    await entered.promise
    const last = setSessionMode("ses_order_child", directory, "plan")
    const message = send("ses_order_child", directory, { text: "Continue", files: [] })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(modes).toEqual(["execute"])
    expect(submissions).toBe(0)
    release.resolve()
    await Promise.all([first, last, message])
    expect(modes).toEqual(["execute", "plan"])
    expect(submissions).toBe(1)
    expect(choice("ses_order_child", directory).mode).toBe("plan")
    expect(choice("ses_order_root", directory).mode).toBe("plan")
  } finally {
    release.resolve()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test.each(["text", "command", "external"])(
  "%s submission inherits server policy while the cached session still says auto",
  async (kind) => {
    const received: Record<string, unknown>[] = []
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      if (request.method === "POST") received.push(JSON.parse(Buffer.concat(chunks).toString()))
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(request.url?.startsWith("/command") ? [{ name: "build" }] : {}))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture did not listen")
    vi.stubGlobal("location", { origin: `http://127.0.0.1:${address.port}` })
    const directory = `/stale-send-${kind}`
    setState("sessions", "session", [
      {
        id: "ses_stale",
        directory,
        sessionMode: "auto",
        ...(kind === "external" ? { target: { kind: "external" } } : {}),
      } as Session,
    ])
    try {
      await send("ses_stale", directory, { text: kind === "command" ? "/build fix" : "Continue", files: [] })
      expect(received).toHaveLength(1)
      expect(received[0]).not.toHaveProperty("sessionMode")
      await send("ses_stale", directory, { text: "Initial message", files: [] }, "plan")
      expect(received[1]?.sessionMode).toBe("plan")
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  },
)
