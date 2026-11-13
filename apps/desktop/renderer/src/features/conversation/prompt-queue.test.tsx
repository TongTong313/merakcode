import type { Message, Part } from "@merakcode/sdk/client"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { Messages } from "./messages"
import { PromptQueue } from "./prompt-queue"

const http = vi.hoisted(() => ({
  plan: undefined as unknown,
  patches: [] as { url: string; body: unknown }[],
  deletes: [] as string[],
  posts: [] as string[],
}))

vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (url: string, init?: { method?: string; body?: ArrayBuffer }) => {
    if (init?.method === "PATCH" && url.includes("/queue/")) {
      const body = init.body ? JSON.parse(new TextDecoder().decode(init.body)) : {}
      http.patches.push({ url, body })
      return Response.json({ items: [{ messageID: "u2" }] })
    }
    if (init?.method === "DELETE" && url.includes("/queue/")) {
      http.deletes.push(url)
      return Response.json({ items: [] })
    }
    if (init?.method === "POST" && url.includes("/queue/") && url.includes("/send")) {
      http.posts.push(url)
      return Response.json({ items: [] })
    }
    return Response.json(http.plan ?? { sessionID: "none", content: "", revision: 0 })
  },
}))

let cleanup = () => {}
beforeEach(() => {
  setLocale("zh")
  http.patches.length = 0
  http.deletes.length = 0
  http.posts.length = 0
})
afterEach(() => {
  http.plan = undefined
  cleanup()
  cleanup = () => {}
})

const userMessage = (id: string, sessionID: string, created: number): Message =>
  ({ id, sessionID, role: "user", time: { created } }) as Message

const assistantMessage = (id: string, sessionID: string, parentID: string, created: number): Message =>
  ({
    id,
    sessionID,
    role: "assistant",
    parentID,
    time: { created },
  }) as Message

const textPart = (id: string, sessionID: string, messageID: string, text: string): Part =>
  ({ id, sessionID, messageID, type: "text", text }) as Part

function setupQueue() {
  const sessionID = "queue-panel"
  setState("sessions", "message", sessionID, [
    userMessage("u1", sessionID, 0),
    assistantMessage("a1", sessionID, "u1", 1_000),
    { ...userMessage("u2", sessionID, 2_000), queued: true } as Message,
  ])
  setState("sessions", "part", "u1", [textPart("p0", sessionID, "u1", "第一轮任务")])
  setState("sessions", "part", "a1", [textPart("p1", sessionID, "a1", "第一轮答案")])
  setState("sessions", "part", "u2", [textPart("p2", sessionID, "u2", "排队中的下一条")])
  setState("sessions", "session_status", sessionID, { type: "busy" })
  setState("sessions", "session_queue", sessionID, [{ messageID: "u2" }])
  return sessionID
}

test("a follow-up marked queued stays out of the working timeline before the queue event arrives", () => {
  const sessionID = "queue-mark"
  setState("sessions", "message", sessionID, [
    userMessage("u1", sessionID, 0),
    assistantMessage("a1", sessionID, "u1", 1_000),
    { ...userMessage("u2", sessionID, 2_000), queued: true } as Message,
  ])
  setState("sessions", "part", "u1", [textPart("p0", sessionID, "u1", "第一轮任务")])
  setState("sessions", "part", "a1", [textPart("p1", sessionID, "a1", "第一轮答案")])
  setState("sessions", "part", "u2", [textPart("p2", sessionID, "u2", "排队标记中的消息")])
  setState("sessions", "session_status", sessionID, { type: "busy" })
  // session_queue intentionally empty: message.updated can arrive before session.queue.updated.

  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => <Messages sessionID={sessionID} directory="/p" onReviewTurn={() => {}} onReviewFile={() => {}} />,
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }

  expect(host.querySelectorAll(".turn")).toHaveLength(1)
  expect(host.textContent).not.toContain("排队标记中的消息")
  expect(host.querySelector(".working")).not.toBeNull()
})

test("a queued follow-up appears in the queue panel and not as a working turn", () => {
  const sessionID = setupQueue()
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <>
        <Messages sessionID={sessionID} directory="/p" onReviewTurn={() => {}} onReviewFile={() => {}} />
        <PromptQueue sessionID={sessionID} directory="/p" />
      </>
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }

  const queue = host.querySelector(".prompt-queue")
  expect(queue?.textContent).toContain("排队中的下一条")
  expect(host.querySelectorAll(".turn")).toHaveLength(1)
  expect(host.querySelector(".turn")?.textContent).toContain("第一轮答案")
  expect(host.querySelector(".turn")?.textContent).not.toContain("排队中的下一条")
  expect(host.querySelector(".working")).not.toBeNull()
})

test("editing a queued follow-up updates the panel text", async () => {
  const sessionID = setupQueue()
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(() => <PromptQueue sessionID={sessionID} directory="/p" />, host)
  cleanup = () => {
    dispose()
    host.remove()
  }

  host.querySelector<HTMLButtonElement>('[aria-label="修改排队消息"]')!.click()
  const editor = host.querySelector<HTMLTextAreaElement>(".prompt-queue-editor")!
  expect(editor.value).toBe("排队中的下一条")
  editor.value = "改后的文案"
  editor.dispatchEvent(new Event("input", { bubbles: true }))
  ;[...host.querySelectorAll("button")].find((button) => button.textContent === "保存")!.click()

  await vi.waitFor(() => expect(http.patches.length).toBe(1))
  expect(http.patches[0]?.body).toEqual({ text: "改后的文案" })
  await vi.waitFor(() => expect(host.querySelector(".prompt-queue")?.textContent).toContain("改后的文案"))
  expect(host.querySelector(".prompt-queue-editor")).toBeNull()
})

test("removing a queued follow-up clears it from the panel", async () => {
  const sessionID = setupQueue()
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(() => <PromptQueue sessionID={sessionID} directory="/p" />, host)
  cleanup = () => {
    dispose()
    host.remove()
  }

  host.querySelector<HTMLButtonElement>('[aria-label="删除排队消息"]')!.click()
  await vi.waitFor(() => expect(http.deletes.length).toBe(1))
  await vi.waitFor(() => expect(host.querySelector(".prompt-queue")).toBeNull())
})

test("sending a queued follow-up now asks the engine to run it next", async () => {
  const sessionID = setupQueue()
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(() => <PromptQueue sessionID={sessionID} directory="/p" />, host)
  cleanup = () => {
    dispose()
    host.remove()
  }

  host.querySelector<HTMLButtonElement>('[aria-label="立即发送"]')!.click()
  await vi.waitFor(() => expect(http.posts.some((url) => url.includes("/send"))).toBe(true))
})
