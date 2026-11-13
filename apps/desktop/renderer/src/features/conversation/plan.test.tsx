import { render } from "solid-js/web"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"
import { engineFixture } from "../../test/engine"
import { setLocale } from "../../i18n"
import { client } from "../../state/client"
import { buffersFor, releaseBuffers } from "../code/state"
import { panels, selectPanels } from "../panel/workspace"
import { PlanCard, PlanPanel } from "./plan"

// The code editor is a browser component; a plain text model stands in for it. Everything else is real.
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

const long = "# Full plan\n\n" + Array.from({ length: 25 }, (_, i) => `Paragraph ${i}\n\n`).join("") + "LAST_PARAGRAPH"
const contents = [
  "# Plan\n1. Read\n2. Change",
  long,
  "# Executing plan\n1. Go",
  "# Draft plan\n1. Old",
  "# Stopped plan\n1. Go",
]
const writePlan = (content: string) => ({
  calls: [{ id: crypto.randomUUID(), name: "write_plan", input: { content } }],
})
let env: Awaited<ReturnType<typeof engineFixture>>
const sessions: string[] = []

beforeAll(async () => {
  env = await engineFixture({
    replies: [...contents.map(writePlan), ...Array.from({ length: 30 }, () => ({ text: "Done" }))],
  })
  location.href = env.url
  const connection = await client()
  for (const _ of contents) {
    const created = await connection.session.create({ provider: "fake", model: "test", workdir: env.project })
    await connection.session.send({ session: created.session, parts: [{ text: "Plan it" }], plan: true })
    await vi.waitFor(() => connection.plan.get({ session: created.session }), { timeout: 20_000 })
    sessions.push(created.session)
  }
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  releaseBuffers(env.project)
})

function mount(node: () => import("solid-js").JSX.Element) {
  setLocale("zh")
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(node, host)
  cleanups.push(() => {
    dispose()
    host.remove()
  })
  return host
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((item) => item.textContent === label)
const selectedKind = () => panels()?.state.tabs.find((tab) => tab.id === panels()?.state.selected)
const userTurns = async (session: string) =>
  ((await (await client()).session.snapshot({ session })).messages ?? []).filter((message) => message.role === "user")
    .length

test("the session plan card presents one plan and opens the existing editor", async () => {
  const session = sessions[0]!
  await selectPanels({ directory: env.project, sessionID: session })
  const host = mount(() => <PlanCard sessionID={session} directory={env.project} />)
  await vi.waitFor(() => expect(host.textContent).toContain("计划已生成"))
  expect(host.textContent).toContain("待审核")
  button(host, "查看计划")!.click()
  await vi.waitFor(() => expect(selectedKind()?.kind).toBe("plan"))
  expect([...host.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
    "查看计划",
    "开始执行",
    "继续修改",
  ])
})

test("the plan tab shows full Markdown and opens the editor only on an explicit edit", async () => {
  const session = sessions[1]!
  await selectPanels({ directory: env.project, sessionID: session })
  const host = mount(() => <PlanPanel sessionID={session} directory={env.project} />)
  await vi.waitFor(() => expect(host.querySelector(".markdown")?.textContent).toContain("Full plan"))
  expect(host.querySelectorAll(".markdown p")).toHaveLength(26)
  expect(host.textContent).toContain("LAST_PARAGRAPH")
  expect(panels()?.state.tabs).toEqual([])
  button(host, "编辑计划")!.click()
  await vi.waitFor(() => expect(selectedKind()).toMatchObject({ kind: "file", planSessionID: session }))
})

test("starting a plan executes it once and an executing plan opens progress without dispatching another task", async () => {
  const session = sessions[2]!
  const connection = await client()
  await selectPanels({ directory: env.project, sessionID: session })
  const host = mount(() => <PlanCard sessionID={session} directory={env.project} />)
  await vi.waitFor(() => expect(button(host, "开始执行")).toBeTruthy())
  const before = await userTurns(session)
  button(host, "开始执行")!.click()
  await vi.waitFor(() => expect(host.textContent).toContain("当前任务按开始执行时的计划进行"))
  expect(await connection.plan.get({ session })).toMatchObject({ status: "executing", snapshot: contents[2] })
  expect(await userTurns(session)).toBe(before + 1)
  const start = button(host, "开始执行")!
  expect(start.disabled).toBe(true)
  start.click()
  button(host, "查看计划")!.click()
  await vi.waitFor(() => expect(selectedKind()?.kind).toBe("plan"))
  const panel = mount(() => <PlanPanel sessionID={session} directory={env.project} />)
  await vi.waitFor(() => expect(button(panel, "查看执行进度")).toBeTruthy())
  button(panel, "查看执行进度")!.click()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(await userTurns(session)).toBe(before + 1)
  expect(await connection.plan.get({ session })).toMatchObject({ status: "executing" })
})

test("an executing plan keeps its fixed snapshot while the panel shows the latest saved text", async () => {
  const session = sessions[2]!
  const connection = await client()
  const current = await connection.plan.get({ session })
  await connection.plan.save({ session, content: "LATEST_HUMAN_B", revision: current.revision })
  const host = mount(() => <PlanPanel sessionID={session} directory={env.project} />)
  await vi.waitFor(() => expect(host.textContent).toContain("LATEST_HUMAN_B"))
  expect(host.textContent).toContain("当前任务按开始执行时的计划进行")
  expect(button(host, "查看执行进度")).toBeTruthy()
  expect(await connection.plan.get({ session })).toMatchObject({ content: "LATEST_HUMAN_B", snapshot: contents[2] })
})

test("starting from the panel saves an editor draft first and executes exactly what was saved", async () => {
  const session = sessions[3]!
  const connection = await client()
  await selectPanels({ directory: env.project, sessionID: session })
  const buffer = buffersFor(env.project)
  await buffer.open(`Plan-${session}.md`, session)
  buffer.tabs[0]!.model!.setValue("# Draft plan\n1. New step")
  await buffer.suspend(buffer.tabs[0]!.path, "view")
  const host = mount(() => <PlanPanel sessionID={session} directory={env.project} />)
  await vi.waitFor(() => expect(button(host, "开始执行")).toBeTruthy())
  button(host, "开始执行")!.click()
  await vi.waitFor(async () =>
    expect(await connection.plan.get({ session })).toMatchObject({
      status: "executing",
      snapshot: "# Draft plan\n1. New step",
    }),
  )
})

test("a stopped plan can be started again from its card and runs its latest saved content", async () => {
  const session = sessions[4]!
  const connection = await client()
  await connection.plan.execute({ session })
  const stopped = await connection.plan.stop({ session })
  expect(stopped.status).toBe("stopped")
  await connection.plan.save({ session, content: "# Stopped plan\n1. Go again", revision: stopped.revision })
  await selectPanels({ directory: env.project, sessionID: session })
  const host = mount(() => <PlanCard sessionID={session} directory={env.project} />)
  await vi.waitFor(() => expect(button(host, "开始执行")).toBeTruthy())
  expect(button(host, "开始执行")!.disabled).toBe(false)
  button(host, "开始执行")!.click()
  await vi.waitFor(async () =>
    expect(await connection.plan.get({ session })).toMatchObject({
      status: "executing",
      snapshot: "# Stopped plan\n1. Go again",
    }),
  )
})
