import { connectionDefaults } from "./product.fixture"
import { createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import type { ToolPart } from "@merakcode/sdk/client"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { SeatBubble, type GroupView } from "./messages"

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
    { id: "s1", name: "小主", role: "", duty: "", product: "merak", leader: true, availability: { state: "online" } },
    {
      id: "s2",
      name: "小红",
      role: "产品经理",
      duty: "负责登录",
      product: "claude",
      leader: false,
      availability: { state: "online" },
    },
  ],
  events: [],
  products: [
    {
      id: "merak",
      title: "MerakCode",
      connected: true,
      enabled: true,
      builtin: true,
      source: "builtin",
      ...connectionDefaults,
    },
    {
      id: "claude",
      title: "Claude Code",
      connected: true,
      enabled: true,
      builtin: true,
      source: "builtin",
      ...connectionDefaults,
    },
    {
      id: "codex",
      title: "Codex",
      connected: true,
      enabled: true,
      builtin: true,
      source: "builtin",
      ...connectionDefaults,
    },
  ],
}

const input = { seat: "小红", task: "做登录", paths: ["src/auth/**"] }
const time = { start: 1, end: 2 }

function delegate(state: ToolPart["state"]): ToolPart {
  return { id: "p", sessionID: "s", messageID: "m", type: "tool", callID: "c", tool: "delegate", state }
}

test("a member's finished reply shows under its name, product and role, with the task it was given", () => {
  const host = mount(() => (
    <SeatBubble
      group={group}
      part={delegate({
        status: "completed",
        input,
        output: "登录入口已改到 **src/auth/login.ts**",
        title: "小红",
        metadata: { seatID: "s2", product: "claude" },
        time,
      })}
    />
  ))
  const article = host.querySelector("article")!
  expect(article.getAttribute("aria-label")).toBe("小红")
  expect(article.textContent).toContain("Claude Code · 产品经理")
  expect(article.textContent).toContain("小主：做登录 · src/auth/**")
  expect(article.querySelector("strong")?.textContent).toBe("src/auth/login.ts")
})

test("an external member streams persisted text and renders the final text once", () => {
  const external = {
    runID: "r1",
    productTitle: "Claude Code",
    actualModel: { id: "haiku" },
    parts: [{ id: "text-1", text: "Hello " }],
  }
  const [part, setPart] = createSignal(
    delegate({
      status: "running",
      input,
      metadata: { seatID: "s2", product: "claude", external },
      time: { start: Date.now() },
    }),
  )
  const host = mount(() => <SeatBubble group={group} part={part()} />)
  expect(host.textContent).toContain("Hello")
  expect(host.textContent).not.toContain("world")
  setPart(
    delegate({
      status: "completed",
      input,
      title: "小红",
      output: "Hello world",
      metadata: {
        seatID: "s2",
        product: "claude",
        external: { ...external, parts: [{ id: "text-1", text: "Hello world" }], terminal: "completed" },
      },
      time,
    }),
  )
  expect(host.textContent?.match(/Hello world/g)).toHaveLength(1)
})

test.each([
  ["zh", "完成后输出"],
  ["en", "Output on completion"],
] as const)("a member describes its non-streaming output in %s", (locale, label) => {
  setLocale(locale)
  const [view, setView] = createSignal(group)
  const host = mount(() => (
    <>
      <SeatBubble
        group={view()}
        part={delegate({ status: "running", input, metadata: { seatID: "s2", product: "claude" }, time })}
      />
      <SeatBubble
        group={view()}
        part={delegate({
          status: "running",
          input: { seat: "小主" },
          metadata: { seatID: "s1", product: "merak" },
          time,
        })}
      />
    </>
  ))
  const member = () => host.querySelector('article[aria-label="小红"]')!
  expect(member().textContent).toContain(label)
  expect(host.querySelector('article[aria-label="小主"]')!.textContent).not.toContain(label)
  setView({
    ...group,
    products: group.products.map((product) => ({
      ...product,
      capabilities: { ...product.capabilities, textStreaming: true },
    })),
  })
  expect(member().textContent).not.toContain(label)
  setView({ ...group, products: group.products.map((product) => ({ ...product, connected: false })) })
  expect(member().textContent).not.toContain(label)
})

test("a member that is waiting, working, missing or failing says so", () => {
  const cases: [ToolPart["state"], string][] = [
    [{ status: "pending", input, raw: "" }, "排队中…"],
    [{ status: "running", input, metadata: { seatID: "s2", phase: "queued" }, time }, "排队中…"],
    [{ status: "running", input, metadata: { seatID: "s2" }, time }, "已运行"],
    [{ status: "error", input, error: "exit 1", time }, "没有完成：exit 1"],
  ]
  for (const [state, shown] of cases) {
    const host = mount(() => <SeatBubble group={group} part={delegate(state)} />)
    expect(host.textContent).toContain(shown)
    cleanup()
  }
})

test("a member whose command is not installed is shown in the user's language, not the leader's English note", () => {
  const host = mount(() => (
    <SeatBubble
      group={group}
      part={delegate({
        status: "completed",
        input,
        output: "Claude Code is not installed, so 小红 did not start.",
        title: "小红",
        metadata: { seatID: "s2", product: "claude", missing: true },
        time,
      })}
    />
  ))
  expect(host.textContent).toContain("Claude Code 未安装")
  expect(host.textContent).not.toContain("did not start")
})

test.each([
  ["zh", "离线", "completed"],
  ["en", "Offline", "completed"],
  ["zh", "离线", "error"],
  ["en", "Offline", "error"],
] as const)("a disabled member shows its offline state in %s/%s/%s", (locale, offline, status) => {
  setLocale(locale)
  const base = {
    input,
    metadata: {
      seatID: "s2",
      product: "claude",
      external: {
        runID: "r1",
        productTitle: "Claude Code",
        parts: status === "error" ? [{ id: "text-1", text: "Partial reply" }] : [],
        terminal: "cancelled" as const,
        stopReason: "product-disabled" as const,
      },
    },
    time,
  }
  const state: ToolPart["state"] =
    status === "completed"
      ? { ...base, status, output: "Member is offline because Claude Code is disabled.", title: "Member" }
      : { ...base, status, error: "MRK-4006: The product was disabled; the member is offline" }
  const host = mount(() => <SeatBubble group={group} part={delegate(state)} />)
  expect(host.textContent).toContain(offline)
  expect(host.textContent).not.toContain("is disabled")
  expect(host.textContent).not.toContain("The product was disabled")
  expect(host.textContent).not.toMatch(/未安装|not installed/i)
  if (status === "error") expect(host.textContent).toContain("Partial reply")
})

test("a removed member's old reply keeps the name and product it had", () => {
  const host = mount(() => (
    <SeatBubble
      group={group}
      part={delegate({
        status: "completed",
        input: { seat: "abc", task: "做支付" },
        output: "支付已拆开",
        title: "abc",
        metadata: { seatID: "s9", product: "codex" },
        time,
      })}
    />
  ))
  expect(host.querySelector("article")?.getAttribute("aria-label")).toBe("abc")
  expect(host.textContent).toContain("Codex")
  expect(host.textContent).toContain("支付已拆开")
})

test("a MerakCode member's bubble opens the child session it worked in", () => {
  const opened: string[] = []
  const host = mount(() => (
    <SeatBubble
      group={{ ...group, onOpenSession: (id) => opened.push(id) }}
      part={delegate({
        status: "completed",
        input: { seat: "小明", task: "看退款" },
        output: "看完了",
        title: "小明",
        metadata: { seatID: "s3", product: "merak", sessionId: "ses_child" },
        time,
      })}
    />
  ))
  ;[...host.querySelectorAll("button")].find((item) => item.textContent === "查看过程")!.click()
  expect(opened).toEqual(["ses_child"])
})

test("clicking a member's avatar opens that member in the member column; a removed member's avatar does nothing", () => {
  const opened: string[] = []
  const part = (seatID: string, seat: string) =>
    delegate({
      status: "completed",
      input: { seat, task: "做" },
      output: "好了",
      title: seat,
      metadata: { seatID, product: "claude" },
      time,
    })
  const host = mount(() => (
    <>
      <SeatBubble group={{ ...group, onOpenMember: (id) => opened.push(id) }} part={part("s2", "小红")} />
      <SeatBubble group={{ ...group, onOpenMember: (id) => opened.push(id) }} part={part("s9", "abc")} />
    </>
  ))
  const [present, removed] = [...host.querySelectorAll("article")]
  present!.querySelector<HTMLButtonElement>("button[aria-label='小红']")!.click()
  expect(opened).toEqual(["s2"])
  expect(removed!.querySelector("button[aria-label='abc']")).toBeNull()
})

test("a member that failed or was stopped keeps its product and role, though the error drops the call's details", () => {
  const host = mount(() => (
    <SeatBubble
      group={group}
      part={delegate({
        status: "error",
        input,
        error: "Claude Code returned no reply",
        metadata: { errorKind: "execution" },
        time,
      })}
    />
  ))
  expect(host.textContent).toContain("Claude Code · 产品经理")
  expect(host.textContent).toContain("没有完成：Claude Code returned no reply")
})

const steps = [
  { tool: "Bash", detail: "node --version" },
  { tool: "Write", detail: "docs/prd.md" },
]

test("a member at work shows how long it has been working and what it is doing now; its steps open on demand", () => {
  const started = Date.now() - 80_000
  const host = mount(() => (
    <SeatBubble
      group={group}
      part={delegate({
        status: "running",
        input,
        metadata: { seatID: "s2", product: "claude", steps },
        time: { start: started },
      })}
    />
  ))
  expect(host.textContent).toContain("已运行 1 分 20 秒")
  expect(host.textContent).toContain("Write docs/prd.md")
  expect(host.textContent).not.toContain("node --version")
  const toggle = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("2 步"))!
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  toggle.click()
  expect(host.textContent).toContain("Bash node --version")
})

test("a finished member keeps its steps, folded under the reply", () => {
  const host = mount(() => (
    <SeatBubble
      group={group}
      part={delegate({
        status: "completed",
        input,
        output: "写好了",
        title: "小红",
        metadata: { seatID: "s2", product: "claude", steps },
        time,
      })}
    />
  ))
  expect(host.textContent).toContain("写好了")
  expect(host.textContent).not.toContain("docs/prd.md")
  const toggle = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("2 步"))!
  toggle.click()
  expect(host.textContent).toContain("Write docs/prd.md")
})

test("a member that waited in the queue shows the time since it started, not since it was asked", () => {
  const host = mount(() => (
    <SeatBubble
      group={group}
      part={delegate({
        status: "running",
        input,
        metadata: { seatID: "s2", product: "claude", started: Date.now() - 5_000 },
        time: { start: Date.now() - 120_000 },
      })}
    />
  ))
  expect(host.textContent).toContain("已运行 5 秒")
})

test("a member that waits for the user's approval or answer says so", () => {
  const running = delegate({ status: "running", input, metadata: { seatID: "s2" }, time })
  const request = { sessionID: "s", tool: { messageID: "m", callID: "c" } }
  setState("sessions", "permission", "s", [{ ...request, id: "per_1", permission: "bash", patterns: [] } as never])
  const approving = mount(() => <SeatBubble group={group} part={running} />)
  expect(approving.textContent).toContain("等待你批准")
  cleanup()
  setState("sessions", "permission", "s", [])
  setState("sessions", "question", "s", [{ ...request, id: "que_1", questions: [] } as never])
  const asking = mount(() => <SeatBubble group={group} part={running} />)
  expect(asking.textContent).toContain("等待你回答")
  cleanup()
  setState("sessions", "question", "s", [])
})
