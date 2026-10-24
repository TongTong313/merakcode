import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import type { Message, Part } from "@merakcode/sdk/client"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { Messages, type GroupView } from "./messages"

let cleanup = () => {}

beforeEach(() => setLocale("zh"))

afterEach(() => {
  cleanup()
  cleanup = () => {}
})

function mount(node: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(node, host)
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host
}

const group: GroupView = {
  seats: [
    { id: "s1", name: "小主", role: "", duty: "", product: "merak", leader: true },
    { id: "s2", name: "小红", role: "产品经理", duty: "", product: "claude", leader: false },
  ],
  events: [
    { at: 5, kind: "join", names: ["小红"] },
    { at: 50, kind: "rename", names: ["小红", "小芳"] },
  ],
  products: [
    { id: "merak", title: "MerakCode", connected: true, enabled: true, builtin: true, source: "builtin" },
    { id: "claude", title: "Claude Code", connected: true, enabled: true, builtin: true, source: "builtin" },
  ],
}

/** One conversation in the store: a user message and the leader's reply to it */
function conversation(sessionID: string, parts: Part[], working = false) {
  const user = { id: "u1", sessionID, role: "user", time: { created: 10 } } as Message
  const reply = { id: "a1", sessionID, role: "assistant", parentID: "u1", time: { created: 11 } } as Message
  setState("sessions", "message", sessionID, [user, reply])
  setState("sessions", "part", "u1", [
    { id: "p0", sessionID, messageID: "u1", type: "text", text: "@小红 做登录" } as Part,
  ])
  setState("sessions", "part", "a1", parts)
  setState("sessions", "session_status", sessionID, working ? { type: "busy" } : { type: "idle" })
}

const part = (id: string, fields: Record<string, unknown>) =>
  ({ id, sessionID: "g", messageID: "a1", ...fields }) as Part

test("a group turn reads as a chat: the user, the leader, the member it delegated to, the leader again", () => {
  conversation("g", [
    part("1", { type: "text", text: "好，交给小红" }),
    part("2", {
      type: "tool",
      tool: "delegate",
      callID: "c",
      state: {
        status: "completed",
        input: { seat: "小红", task: "做登录" },
        output: "登录做完了",
        title: "小红",
        metadata: { seatID: "s2", product: "claude" },
        time: { start: 1, end: 2 },
      },
    }),
    part("3", { type: "text", text: "都做完了" }),
  ])
  const host = mount(() => (
    <Messages sessionID="g" directory="/p" group={group} onReviewTurn={() => {}} onReviewFile={() => {}} />
  ))
  const rows = [...host.querySelectorAll("article")].map((item) => [item.getAttribute("aria-label"), item.textContent])
  expect(rows.map(([name]) => name)).toEqual(["你说", "小主", "小红", "小主"])
  expect(rows[1]![1]).toContain("好，交给小红")
  expect(rows[2]![1]).toContain("Claude Code · 产品经理")
  expect(rows[2]![1]).toContain("登录做完了")
  expect(rows[3]![1]).toContain("都做完了")
  const lines = [...host.querySelectorAll(".system-line")].map((item) => item.textContent)
  expect(lines).toEqual(["你邀请 小红 加入了群聊", "小红 改名为 小芳"])
  expect(host.textContent!.indexOf("加入了群聊")).toBeLessThan(host.textContent!.indexOf("@小红 做登录"))
  expect(host.textContent!.indexOf("改名为")).toBeGreaterThan(host.textContent!.indexOf("都做完了"))
})

test("while the leader is still writing, a thought it has finished shows how long it took", () => {
  conversation(
    "w",
    [
      part("1", { type: "reasoning", text: "想一想", time: { start: 0, end: 3_000 } }),
      part("2", { type: "text", text: "正在写" }),
    ],
    true,
  )
  const host = mount(() => (
    <Messages sessionID="w" directory="/p" group={group} onReviewTurn={() => {}} onReviewFile={() => {}} />
  ))
  expect(host.textContent).toContain("思考了 3 秒")
})

test("a new team shows everyone in it and how to start", () => {
  setState("sessions", "message", "e", [])
  const host = mount(() => (
    <Messages sessionID="e" directory="/p" group={group} onReviewTurn={() => {}} onReviewFile={() => {}} />
  ))
  const intro = host.querySelector(".group-intro")!
  expect(intro.querySelectorAll(".avatar")).toHaveLength(2)
  expect(intro.textContent).toContain("小主、小红 已就位")
  expect(intro.textContent).toContain("直接说要做什么，或用 @ 点名某个成员")
})

test("a team of the leader alone suggests adding members", () => {
  setState("sessions", "message", "e1", [])
  const alone = { ...group, seats: group.seats.filter((seat) => seat.leader) }
  const host = mount(() => (
    <Messages sessionID="e1" directory="/p" group={alone} onReviewTurn={() => {}} onReviewFile={() => {}} />
  ))
  const intro = host.querySelector(".group-intro")!
  expect(intro.querySelectorAll(".avatar")).toHaveLength(1)
  expect(intro.textContent).toContain("在右侧添加 Claude Code、Codex 等成员，或直接交代任务")
})

test("an ordinary conversation keeps its layout: no member bubbles", () => {
  conversation("o", [part("1", { type: "text", text: "普通回复" })])
  const host = mount(() => <Messages sessionID="o" directory="/p" onReviewTurn={() => {}} onReviewFile={() => {}} />)
  expect([...host.querySelectorAll("article")].map((item) => item.getAttribute("aria-label"))).toEqual(["你说"])
  expect(host.textContent).toContain("普通回复")
})

test("after the group is stopped, a member that was still working reads as stopped", () => {
  conversation("s", [
    part("1", {
      type: "tool",
      tool: "delegate",
      callID: "c",
      state: {
        status: "running",
        input: { seat: "小红", task: "做登录" },
        metadata: { seatID: "s2" },
        time: { start: 1 },
      },
    }),
  ])
  const host = mount(() => (
    <Messages sessionID="s" directory="/p" group={group} onReviewTurn={() => {}} onReviewFile={() => {}} />
  ))
  const xiaohong = [...host.querySelectorAll("article")].find((item) => item.getAttribute("aria-label") === "小红")!
  expect(xiaohong.textContent).toContain("已停止")
  expect(xiaohong.textContent).not.toContain("正在处理")
})

test("the leader's steps sit outside its bubble, as in an ordinary conversation; the bubble holds its words", () => {
  conversation("b", [
    part("1", {
      type: "tool",
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: { command: "npm test" },
        output: "ok",
        title: "npm test",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }),
    part("2", { type: "text", text: "测试都过了" }),
  ])
  const host = mount(() => (
    <Messages sessionID="b" directory="/p" group={group} onReviewTurn={() => {}} onReviewFile={() => {}} />
  ))
  const leader = [...host.querySelectorAll("article")].find((item) => item.getAttribute("aria-label") === "小主")!
  const bubbles = [...leader.querySelectorAll(".bubble")].map((item) => item.textContent?.trim())
  expect(bubbles).toEqual(["测试都过了"])
  expect(leader.textContent).toContain("npm test")
})

test("a member's task reads above its bubble, which holds only its reply", () => {
  conversation("t", [
    part("1", {
      type: "tool",
      tool: "delegate",
      callID: "c",
      state: {
        status: "completed",
        input: { seat: "小红", task: "做登录", paths: ["src/auth/**"] },
        output: "登录做完了",
        title: "小红",
        metadata: { seatID: "s2", product: "claude" },
        time: { start: 1, end: 2 },
      },
    }),
  ])
  const host = mount(() => (
    <Messages sessionID="t" directory="/p" group={group} onReviewTurn={() => {}} onReviewFile={() => {}} />
  ))
  const member = [...host.querySelectorAll("article")].find((item) => item.getAttribute("aria-label") === "小红")!
  expect(member.querySelector(".bubble")!.textContent?.trim()).toBe("登录做完了")
  expect(member.textContent).toContain("小主：做登录 · src/auth/**")
})

const failedCall = (error: string) =>
  part("1", {
    type: "tool",
    tool: "delegate",
    callID: "c",
    state: { status: "error", input: { seat: "小红", task: "做登录" }, error, time: { start: 1, end: 2 } },
  })

test("a member whose turn was stopped reads as stopped, not as the engine's error", () => {
  conversation("x", [failedCall("Tool execution aborted")])
  setState(
    "sessions",
    "message",
    "x",
    1,
    "error" as never,
    { name: "MessageAbortedError", data: { message: "Operation aborted by user" } } as never,
  )
  const host = mount(() => (
    <Messages sessionID="x" directory="/p" group={group} onReviewTurn={() => {}} onReviewFile={() => {}} />
  ))
  const member = [...host.querySelectorAll("article")].find((item) => item.getAttribute("aria-label") === "小红")!
  expect(member.textContent).toContain("已停止")
  expect(member.textContent).not.toContain("Tool execution aborted")
})

test("a member that failed on its own still says why", () => {
  conversation("y", [failedCall("Claude Code returned no reply (exit code 1)")])
  const host = mount(() => (
    <Messages sessionID="y" directory="/p" group={group} onReviewTurn={() => {}} onReviewFile={() => {}} />
  ))
  const member = [...host.querySelectorAll("article")].find((item) => item.getAttribute("aria-label") === "小红")!
  expect(member.textContent).toContain("没有完成：Claude Code returned no reply (exit code 1)")
})

/** A running turn whose reply has a finished thought and a member at work */
function working(sessionID: string) {
  conversation(
    sessionID,
    [
      part("1", { type: "reasoning", text: "想一想", time: { start: 0, end: 3_000 } }),
      part("2", {
        type: "tool",
        tool: "delegate",
        callID: "c",
        state: {
          status: "running",
          input: { seat: "小红", task: "做登录" },
          metadata: { seatID: "s2", product: "claude", started: 1, steps: [{ tool: "Bash", detail: "npm test" }] },
          time: { start: 1 },
        },
      }),
    ],
    true,
  )
}

const expanded = (host: HTMLElement) =>
  [...host.querySelectorAll("button[aria-expanded]")].map((item) => item.getAttribute("aria-expanded"))

for (const [name, view] of [
  ["a group chat", group],
  ["an ordinary conversation", undefined],
] as const) {
  test(`in ${name}, what was opened stays open while the reply goes on and a new message starts`, () => {
    working("k")
    const host = mount(() => (
      <Messages sessionID="k" directory="/p" group={view} onReviewTurn={() => {}} onReviewFile={() => {}} />
    ))
    for (const button of host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")) button.click()
    const opened = expanded(host)
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.every((value) => value === "true")).toBe(true)
    setState("sessions", "part", "a1", 0, "text" as never, "想一想，再想想" as never)
    expect(expanded(host)).toEqual(opened)
    setState("sessions", "message", "k", 2, {
      id: "a2",
      sessionID: "k",
      role: "assistant",
      parentID: "u1",
      time: { created: 12 },
    } as Message)
    expect(expanded(host)).toEqual(opened)
  })
}
