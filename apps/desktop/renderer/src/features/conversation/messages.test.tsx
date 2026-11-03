import type { Message, Part } from "@merakcode/sdk/client"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { Messages } from "./messages"

const http = vi.hoisted(() => ({ plan: undefined as unknown }))
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async () => Response.json(http.plan ?? { sessionID: "none", content: "", revision: 0 }),
}))

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII="

let cleanup = () => {}
beforeEach(() => setLocale("zh"))
afterEach(() => {
  http.plan = undefined
  cleanup()
  cleanup = () => {}
})

function renderSentImage(sessionID: string) {
  const messageID = `u-${sessionID}`
  const message = { id: messageID, sessionID, role: "user", time: { created: 1 } } as Message
  setState("sessions", "message", sessionID, [message])
  setState("sessions", "part", messageID, [
    {
      id: `p-${sessionID}`,
      sessionID,
      messageID,
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: png,
    } as Part,
  ])
  setState("sessions", "session_status", sessionID, { type: "idle" })
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Messages sessionID={sessionID} directory={`/${sessionID}`} onReviewTurn={() => {}} onReviewFile={() => {}} />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host
}

test("a sent image attachment keeps its thumbnail and opens the full image", async () => {
  const host = renderSentImage("image-message")
  expect(host.querySelector(".user-message .attachments img")?.getAttribute("src")).toBe(png)
  host.querySelector<HTMLButtonElement>('[aria-label="查看图片 shot.png"]')!.click()
  await vi.waitFor(() => expect(document.querySelector("[role=dialog] img")?.getAttribute("src")).toBe(png))
  document.querySelector<HTMLButtonElement>("[role=dialog] .dialog-foot button")!.click()
  await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull())
})

test("clicking a sent image's name opens the full image", async () => {
  const host = renderSentImage("image-message-name")
  const name = host.querySelector(".user-message .attachments .ellipsis")
  if (!name) throw new Error("attachment name did not render")
  name.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector("[role=dialog] img")?.getAttribute("src")).toBe(png))
  document.querySelector<HTMLButtonElement>("[role=dialog] .dialog-foot button")!.click()
  await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull())
})

const userMessage = (id: string, sessionID: string, created: number): Message =>
  ({ id, sessionID, role: "user", time: { created } }) as Message

const assistantMessage = (
  id: string,
  sessionID: string,
  parentID: string,
  created: number,
  completed?: number,
): Message =>
  ({
    id,
    sessionID,
    role: "assistant",
    parentID,
    time: { created, ...(completed === undefined ? {} : { completed }) },
  }) as Message

const textPart = (id: string, sessionID: string, messageID: string, text: string): Part =>
  ({ id, sessionID, messageID, type: "text", text }) as Part

const reasoningPart = (id: string, sessionID: string, messageID: string, text: string): Part =>
  ({ id, sessionID, messageID, type: "reasoning", text, time: { start: 0, end: 1_000 } }) as Part

const bashPart = (id: string, sessionID: string, messageID: string): Part =>
  ({
    id,
    sessionID,
    messageID,
    type: "tool",
    tool: "bash",
    callID: id,
    state: {
      status: "completed",
      input: { command: "npm test" },
      output: "ok",
      title: "npm test",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }) as Part

const editPart = (id: string, sessionID: string, messageID: string): Part =>
  ({
    id,
    sessionID,
    messageID,
    type: "tool",
    tool: "edit",
    callID: id,
    state: {
      status: "completed",
      input: { filePath: "/p/auth.ts" },
      output: "",
      title: "auth.ts",
      metadata: { filediff: { file: "/p/auth.ts", before: "", after: "ok\n" } },
      time: { start: 1, end: 2 },
    },
  }) as Part

function conversation(
  sessionID: string,
  messages: Message[],
  parts: Record<string, Part[]>,
  status: "idle" | "busy" = "idle",
) {
  setState("sessions", "message", sessionID, messages)
  for (const [messageID, list] of Object.entries(parts)) setState("sessions", "part", messageID, list)
  setState("sessions", "session_status", sessionID, { type: status })
}

function renderConversation(sessionID: string, directory = "/p") {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => <Messages sessionID={sessionID} directory={directory} onReviewTurn={() => {}} onReviewFile={() => {}} />,
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host
}

test("a finished turn folds its work under a completed-time line and keeps the final answer", () => {
  const sessionID = "fold"
  conversation(
    sessionID,
    [
      userMessage("u1", sessionID, 0),
      assistantMessage("a1", sessionID, "u1", 1_000, 50_000),
      assistantMessage("a2", sessionID, "u1", 50_000, 160_000),
    ],
    {
      u1: [textPart("p0", sessionID, "u1", "做登录")],
      a1: [
        reasoningPart("p1", sessionID, "a1", "先想一想"),
        bashPart("p2", sessionID, "a1"),
        editPart("p3", sessionID, "a1"),
        textPart("p4", sessionID, "a1", "我先看看"),
      ],
      a2: [reasoningPart("p5", sessionID, "a2", "整理答案"), textPart("p6", sessionID, "a2", "登录做好了")],
    },
  )

  const host = renderConversation(sessionID)
  const turn = host.querySelector(".turn")!
  const line = turn.querySelector<HTMLButtonElement>(".turn-summary")
  expect(line?.textContent).toContain("智能体工作完成")
  expect(line?.textContent).toContain("2 分 40 秒")
  expect(turn.textContent).not.toContain("思考了 1 秒")
  expect(turn.textContent).not.toContain("我先看看")
  expect(turn.textContent).not.toContain("npm test")
  expect(turn.textContent).toContain("登录做好了")
  expect(turn.querySelector(".changes-card")?.textContent).toContain("本轮改动")
  expect(turn.querySelectorAll(".assistant")).toHaveLength(1)
  expect(turn.lastElementChild).toBe(turn.querySelector(".changes-card"))

  line!.click()
  expect(line!.getAttribute("aria-expanded")).toBe("true")
  expect(turn.textContent).toContain("思考了 1 秒")
  expect(turn.textContent).toContain("我先看看")
  expect(turn.textContent).toContain("npm test")
  expect(turn.querySelectorAll(".assistant")).toHaveLength(2)

  line!.click()
  expect(line!.getAttribute("aria-expanded")).toBe("false")
  expect(turn.textContent).not.toContain("我先看看")
  expect(turn.textContent).not.toContain("npm test")
})

test("the official plan card stays in its first successful reply after a later turn", async () => {
  const sessionID = "plan-anchor"
  http.plan = {
    sessionID,
    path: "/official.md",
    content: "# Updated plan",
    revision: 2,
    humanRevision: 0,
    source: "agent",
    status: "review",
    anchorMessageID: "a1",
  }
  conversation(
    sessionID,
    [
      userMessage("u1", sessionID, 0),
      assistantMessage("a1", sessionID, "u1", 1, 2),
      userMessage("u2", sessionID, 3),
      assistantMessage("a2", sessionID, "u2", 4, 5),
    ],
    {
      u1: [textPart("p1", sessionID, "u1", "生成方案")],
      a1: [textPart("p2", sessionID, "a1", "首次提交")],
      u2: [textPart("p3", sessionID, "u2", "修改方案")],
      a2: [textPart("p4", sessionID, "a2", "已经更新")],
    },
  )
  const host = renderConversation(sessionID)
  await vi.waitFor(() => expect(host.querySelectorAll(".plan-card")).toHaveLength(1))
  expect(host.querySelector(".plan-card")?.closest(".turn")).toBe(host.querySelector(".turn"))
  expect(host.querySelector(".plan-card")?.getAttribute("data-anchor-message-id")).toBe("a1")
})

test("a group reply split by a delegate keeps exactly one official plan card", async () => {
  const sessionID = "group-plan-anchor"
  http.plan = {
    sessionID,
    path: "/official.md",
    content: "# Group plan",
    revision: 1,
    humanRevision: 0,
    source: "agent",
    status: "review",
    anchorMessageID: "group-a",
  }
  conversation(
    sessionID,
    [
      userMessage("group-u", sessionID, 0),
      assistantMessage("group-a", sessionID, "group-u", 1, 2),
      assistantMessage("group-later", sessionID, "group-u", 3, 4),
    ],
    {
      "group-u": [textPart("group-p1", sessionID, "group-u", "生成方案")],
      "group-later": [textPart("group-later-p", sessionID, "group-later", "LATER_REPLY")],
      "group-a": [
        textPart("group-p2", sessionID, "group-a", "提交计划"),
        {
          id: "group-call",
          type: "tool",
          messageID: "group-a",
          sessionID,
          callID: "delegate",
          tool: "delegate",
          state: {
            status: "completed",
            input: { seat: "Member", task: "Research" },
            output: "Done",
            title: "Member",
            metadata: { phase: "completed" },
            time: { start: 1, end: 2 },
          },
        },
        textPart("group-p3", sessionID, "group-a", "调研完成"),
      ],
    },
  )
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => (
      <Messages
        sessionID={sessionID}
        directory="/p"
        group={{ seats: [], events: [], products: [] }}
        onReviewTurn={() => {}}
        onReviewFile={() => {}}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  await vi.waitFor(() => expect(host.querySelectorAll(".plan-card")).toHaveLength(1))
  expect(host.querySelector(".plan-card")?.getAttribute("data-anchor-message-id")).toBe("group-a")
  const card = host.querySelector(".plan-card")!
  const leaf = (text: string) =>
    [...host.querySelectorAll("*")].find(
      (element) => element.childElementCount === 0 && element.textContent?.trim() === text,
    )!
  await vi.waitFor(() => {
    expect(leaf("调研完成")).toBeDefined()
    expect(leaf("LATER_REPLY")).toBeDefined()
  })
  expect(leaf("调研完成").compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(card.compareDocumentPosition(leaf("LATER_REPLY")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test("a running turn stays open and folds when the session goes idle", () => {
  const sessionID = "running"
  conversation(
    sessionID,
    [userMessage("u1", sessionID, 0), assistantMessage("a1", sessionID, "u1", 1_000)],
    {
      u1: [textPart("p0", sessionID, "u1", "做登录")],
      a1: [reasoningPart("p1", sessionID, "a1", "边想边写"), textPart("p2", sessionID, "a1", "正在回答")],
    },
    "busy",
  )

  const host = renderConversation(sessionID)
  const turn = host.querySelector(".turn")!
  expect(turn.querySelector(".turn-summary")).toBeNull()
  expect(turn.textContent).toContain("思考了 1 秒")
  expect(turn.textContent).toContain("正在回答")

  setState("sessions", "message", sessionID, 1, "time", { created: 1_000, completed: 160_000 })
  setState("sessions", "session_status", sessionID, { type: "idle" })

  const line = turn.querySelector<HTMLButtonElement>(".turn-summary")
  expect(line?.textContent).toContain("2 分 40 秒")
  expect(turn.textContent).not.toContain("思考了 1 秒")
  expect(turn.textContent).toContain("正在回答")
  expect(turn.querySelectorAll(".assistant")).toHaveLength(1)
})

test.each(["busy", "retry"] as const)("the %s status precedes the final changed-files card", (type) => {
  const sessionID = `changes-${type}`
  conversation(
    sessionID,
    [userMessage("changes-u", sessionID, 0), assistantMessage("changes-a", sessionID, "changes-u", 1)],
    {
      "changes-u": [textPart("changes-p", sessionID, "changes-u", "Continue")],
      "changes-a": [editPart("changes-edit", sessionID, "changes-a")],
    },
    "busy",
  )
  if (type === "retry")
    setState("sessions", "session_status", sessionID, {
      type: "retry",
      attempt: 2,
      message: "Controlled retry",
      next: Date.now() + 1000,
    })
  const host = renderConversation(sessionID)
  const changes = host.querySelector(".changes-card")!
  const working = host.querySelector(".working")!
  expect(changes).not.toBeNull()
  expect(working).not.toBeNull()
  expect(working.compareDocumentPosition(changes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(changes.parentElement?.lastElementChild).toBe(changes)
})

test("a queued next message does not fold a still-running turn or unfold a finished one", () => {
  const sessionID = "queued"
  conversation(
    sessionID,
    [
      userMessage("u1", sessionID, 0),
      assistantMessage("a1", sessionID, "u1", 1_000),
      userMessage("u2", sessionID, 2_000),
    ],
    {
      u1: [textPart("p0", sessionID, "u1", "第一轮任务")],
      a1: [reasoningPart("p1", sessionID, "a1", "第一轮思考"), textPart("p2", sessionID, "a1", "第一轮答案")],
      u2: [textPart("p3", sessionID, "u2", "第二轮任务")],
    },
    "busy",
  )

  const host = renderConversation(sessionID)
  const first = host.querySelectorAll(".turn")[0]!
  const second = host.querySelectorAll(".turn")[1]!
  expect(first.querySelector(".turn-summary")).toBeNull()
  expect(first.textContent).toContain("第一轮答案")
  expect(second.querySelector(".turn-summary")).toBeNull()
  expect(second.textContent).toContain("第二轮任务")

  setState("sessions", "message", sessionID, [
    userMessage("u1", sessionID, 0),
    assistantMessage("a1", sessionID, "u1", 1_000, 160_000),
    userMessage("u2", sessionID, 2_000),
    assistantMessage("a2", sessionID, "u2", 3_000),
  ])
  setState("sessions", "part", "a2", [
    reasoningPart("p4", sessionID, "a2", "第二轮思考"),
    textPart("p5", sessionID, "a2", "第二轮回答"),
  ])

  expect(first.querySelector(".turn-summary")?.textContent).toContain("2 分 40 秒")
  expect(first.textContent).not.toContain("第一轮思考")
  expect(first.textContent).toContain("第一轮答案")
  expect(second.querySelector(".turn-summary")).toBeNull()
  expect(second.textContent).toContain("第二轮回答")

  setState("sessions", "message", sessionID, 3, "time", { created: 3_000, completed: 162_000 })
  setState("sessions", "session_status", sessionID, { type: "idle" })
  expect(second.querySelector(".turn-summary")?.textContent).toContain("2 分 40 秒")
  expect(second.textContent).not.toContain("第二轮思考")

  setState("sessions", "message", sessionID, [
    userMessage("u1", sessionID, 0),
    assistantMessage("a1", sessionID, "u1", 1_000, 160_000),
    userMessage("u2", sessionID, 2_000),
    assistantMessage("a2", sessionID, "u2", 3_000, 162_000),
    userMessage("u3", sessionID, 4_000),
  ])
  setState("sessions", "part", "u3", [textPart("p6", sessionID, "u3", "第三轮任务")])
  setState("sessions", "session_status", sessionID, { type: "busy" })

  const third = host.querySelectorAll(".turn")[2]!
  expect(first.querySelector(".turn-summary")).not.toBeNull()
  expect(second.querySelector(".turn-summary")).not.toBeNull()
  expect(third.querySelector(".turn-summary")).toBeNull()
  expect(third.textContent).toContain("第三轮任务")
})

test("a turn stays open until the session reports whether it is running", () => {
  const sessionID = "unknown"
  setState("sessions", "message", sessionID, [
    userMessage("u1", sessionID, 0),
    assistantMessage("a1", sessionID, "u1", 1_000),
  ])
  setState("sessions", "part", "u1", [textPart("p0", sessionID, "u1", "做登录")])
  setState("sessions", "part", "a1", [
    reasoningPart("p1", sessionID, "a1", "边想边写"),
    textPart("p2", sessionID, "a1", "正在回答"),
  ])

  const host = renderConversation(sessionID)
  const turn = host.querySelector(".turn")!
  expect(turn.querySelector(".turn-summary")).toBeNull()
  expect(turn.textContent).toContain("正在回答")

  setState("sessions", "session_status", sessionID, { type: "busy" })
  expect(turn.querySelector(".turn-summary")).toBeNull()

  setState("sessions", "session_status", sessionID, { type: "idle" })
  expect(turn.querySelector(".turn-summary")).not.toBeNull()
})

test("a new turn does not fold while its busy status is settling", () => {
  const sessionID = "sending"
  conversation(sessionID, [], {}, "idle")

  const host = renderConversation(sessionID)
  setState("sessions", "message", sessionID, [userMessage("u1", sessionID, 0)])
  setState("sessions", "part", "u1", [textPart("p0", sessionID, "u1", "做登录")])

  // The user message arrives before the engine reports busy, so the turn is created while idle.
  setState("sessions", "session_status", sessionID, { type: "busy" })
  setState("sessions", "message", sessionID, [
    userMessage("u1", sessionID, 0),
    assistantMessage("a1", sessionID, "u1", 1_000),
  ])
  setState("sessions", "part", "a1", [
    reasoningPart("p1", sessionID, "a1", "边想边写"),
    textPart("p2", sessionID, "a1", "正在回答"),
  ])

  const turn = host.querySelector(".turn")!
  expect(turn.querySelector(".turn-summary")).toBeNull()
  expect(turn.textContent).toContain("思考了 1 秒")
  expect(turn.textContent).toContain("正在回答")

  setState("sessions", "message", sessionID, 1, "time", { created: 1_000, completed: 160_000 })
  setState("sessions", "session_status", sessionID, { type: "idle" })
  expect(turn.querySelector(".turn-summary")?.textContent).toContain("2 分 40 秒")
  expect(turn.textContent).not.toContain("思考了 1 秒")
})

test("a finished turn folds after restart when the status snapshot has no entry for it", () => {
  const sessionID = "restart"
  const directory = "/p-restart"
  setState("sessions", "message", sessionID, [
    userMessage("u1", sessionID, 0),
    assistantMessage("a1", sessionID, "u1", 1_000, 160_000),
  ])
  setState("sessions", "part", "u1", [textPart("p0", sessionID, "u1", "做登录")])
  setState("sessions", "part", "a1", [
    reasoningPart("p1", sessionID, "a1", "先想想"),
    textPart("p2", sessionID, "a1", "登录做好了"),
  ])

  const host = renderConversation(sessionID, directory)
  const turn = host.querySelector(".turn")!
  expect(turn.querySelector(".turn-summary")).toBeNull()

  setState("statusLoaded", directory, true)

  const line = turn.querySelector<HTMLButtonElement>(".turn-summary")
  expect(line?.textContent).toContain("智能体工作完成")
  expect(line?.textContent).toContain("2 分 40 秒")
  expect(turn.textContent).not.toContain("思考了 1 秒")
  expect(turn.textContent).toContain("登录做好了")
})

test("a direct answer with no steps shows no completed-time line", () => {
  const sessionID = "direct"
  conversation(sessionID, [userMessage("u1", sessionID, 0), assistantMessage("a1", sessionID, "u1", 1_000, 160_000)], {
    u1: [textPart("p0", sessionID, "u1", "做登录")],
    a1: [textPart("p1", sessionID, "a1", "登录做好了")],
  })

  const host = renderConversation(sessionID)
  const turn = host.querySelector(".turn")!
  expect(turn.querySelector(".turn-summary")).toBeNull()
  expect(turn.textContent).toContain("登录做好了")
})

test("a turn stopped before answering keeps its steps visible", () => {
  const sessionID = "stopped"
  conversation(sessionID, [userMessage("u1", sessionID, 0), assistantMessage("a1", sessionID, "u1", 1_000)], {
    u1: [textPart("p0", sessionID, "u1", "做登录")],
    a1: [bashPart("p1", sessionID, "a1")],
  })

  const host = renderConversation(sessionID)
  const turn = host.querySelector(".turn")!
  expect(turn.querySelector(".turn-summary")).toBeNull()
  expect(turn.textContent).toContain("npm test")
})

test("copy takes the final answer while folded and the whole turn once expanded", async () => {
  const writeText = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })

  const sessionID = "copy"
  conversation(
    sessionID,
    [
      userMessage("u1", sessionID, 0),
      assistantMessage("a1", sessionID, "u1", 1_000, 50_000),
      assistantMessage("a2", sessionID, "u1", 50_000, 160_000),
    ],
    {
      u1: [textPart("p0", sessionID, "u1", "做登录")],
      a1: [reasoningPart("p1", sessionID, "a1", "先想想"), textPart("p2", sessionID, "a1", "先看看")],
      a2: [textPart("p3", sessionID, "a2", "登录做好了")],
    },
  )

  const host = renderConversation(sessionID)
  const turn = host.querySelector(".turn")!
  turn.querySelector<HTMLButtonElement>('[aria-label="复制"]')!.click()
  await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith("登录做好了"))

  turn.querySelector<HTMLButtonElement>(".turn-summary")!.click()
  turn.querySelector<HTMLButtonElement>('[aria-label="复制"]')!.click()
  await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith("先看看\n\n登录做好了"))
})
