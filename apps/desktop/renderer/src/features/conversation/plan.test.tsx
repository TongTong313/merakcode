import { render } from "solid-js/web"
import { expect, test, vi } from "vitest"
import { PlanCard, PlanPanel } from "./plan"
import { setLocale } from "../../i18n"
import { panels, selectPanels } from "../panel/workspace"
import { choose } from "../../state/models"
import { setState } from "../../state/store"
import type { ProviderListResponses } from "@merakcode/sdk/client"

const http = vi.hoisted(() => ({
  plan: undefined as unknown,
  requests: [] as string[],
  posts: [] as { url: string; body: unknown }[],
}))

test("a paused plan explains that resuming keeps the original snapshot", async () => {
  setLocale("zh")
  http.plan = {
    sessionID: "ses_paused",
    path: "/plan.md",
    content: "LATEST_HUMAN_B",
    revision: 2,
    humanRevision: 2,
    source: "human",
    status: "paused",
    execution: { id: "execution_a", content: "ORIGINAL_A", startedAt: 1, revision: 1, source: "button" },
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <PlanPanel sessionID="ses_paused" directory="/project" />, host)
  try {
    await vi.waitFor(() => expect(host.textContent).toContain("恢复原执行"))
    expect(host.textContent).toContain("固定快照")
    expect(host.textContent).toContain("LATEST_HUMAN_B")
  } finally {
    dispose()
    host.remove()
    http.plan = undefined
  }
})

test.each(["queued", "executing"])("the %s plan opens progress without dispatching another task", async (state) => {
  setLocale("zh")
  await selectPanels({ directory: "/project", sessionID: `ses_${state}` })
  http.requests.length = 0
  http.plan = {
    sessionID: "ses_plan",
    path: "/plan.md",
    content: "Plan",
    revision: 1,
    humanRevision: 0,
    source: "agent",
    status: state === "queued" ? "review" : "executing",
    queued: state === "queued",
    anchorMessageID: "a1",
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <PlanCard sessionID="ses_plan" directory="/project" />, host)
  try {
    await vi.waitFor(() => expect(host.textContent).toContain("查看执行进度"))
    if (state === "queued") expect(host.textContent).toContain("排队")
    ;[...host.querySelectorAll("button")].find((button) => button.textContent === "查看执行进度")?.click()
    await vi.waitFor(() =>
      expect(panels()?.state.tabs.find((tab) => tab.id === panels()?.state.selected)?.kind).toBe("plan"),
    )
    expect(http.requests.some((url) => url.includes("/plan/start"))).toBe(false)
  } finally {
    dispose()
    host.remove()
    http.plan = undefined
  }
})
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (url: string, init?: { body?: ArrayBuffer }) => {
    if (init?.body) http.posts.push({ url, body: JSON.parse(new TextDecoder().decode(init.body)) })
    http.requests.push(url)
    return new Response(
      JSON.stringify(
        http.plan ?? {
          sessionID: "ses_plan",
          path: "/plan.md",
          content: "Plan",
          revision: 1,
          humanRevision: 0,
          source: "agent",
          status: "review",
          anchorMessageID: "a1",
        },
      ),
      { headers: { "content-type": "application/json" } },
    )
  },
}))

test("the session plan card presents one plan and opens the existing editor", async () => {
  setLocale("zh")
  await selectPanels({ directory: "/project", sessionID: "ses_plan" })
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <PlanCard sessionID="ses_plan" directory="/project" />, host)
  try {
    await vi.waitFor(() => expect(host.textContent).toContain("计划已生成"))
    expect(host.textContent).toContain("待审核")
    ;[...host.querySelectorAll("button")].find((button) => button.textContent === "查看计划")?.click()
    await vi.waitFor(() =>
      expect(panels()?.state.tabs.find((tab) => tab.id === panels()?.state.selected)?.kind).toBe("plan"),
    )
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "查看计划",
      "开始执行",
      "继续修改",
    ])
  } finally {
    dispose()
    host.remove()
    vi.unstubAllGlobals()
  }
})

test("the plan tab shows full Markdown and records only an explicit human edit view", async () => {
  setLocale("zh")
  await selectPanels({ directory: "/project", sessionID: "ses_panel" })
  http.requests.length = 0
  http.plan = {
    sessionID: "ses_panel",
    path: "/plan.md",
    content: "# Full plan\n\n" + Array.from({ length: 25 }, (_, i) => `Paragraph ${i}\n\n`).join("") + "LAST_PARAGRAPH",
    revision: 1,
    source: "human",
    status: "draft",
    humanRevision: 1,
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <PlanPanel sessionID="ses_panel" directory="/project" />, host)
  try {
    await vi.waitFor(() => expect(host.querySelector(".markdown")?.textContent).toContain("Full plan"))
    expect(host.querySelectorAll(".markdown p")).toHaveLength(26)
    expect(host.textContent).toContain("LAST_PARAGRAPH")
    expect(http.requests.filter((url) => url.includes("/plan/view"))).toHaveLength(0)
    ;[...host.querySelectorAll("button")].find((button) => button.textContent === "编辑计划")?.click()
    await vi.waitFor(() => expect(http.requests.filter((url) => url.includes("/plan/view"))).toHaveLength(1))
    expect(panels()?.state.tabs.find((tab) => tab.id === panels()?.state.selected)).toMatchObject({
      kind: "file",
      planSessionID: "ses_panel",
    })
  } finally {
    dispose()
    host.remove()
    http.plan = undefined
  }
})

test("resuming a plan sends the model and variant currently selected in the composer", async () => {
  setLocale("zh")
  const id = "ses_resume_selection"
  http.posts.length = 0
  setState("providers", {
    all: [{ id: "fixture", name: "Fixture", env: [], models: { large: { id: "large", name: "Large" } } }],
    connected: ["fixture"],
    default: { fixture: "large" },
  } as unknown as ProviderListResponses[200])
  choose(id, "/project", { model: { providerID: "fixture", modelID: "large" }, variant: "reasoning" })
  http.plan = {
    sessionID: id,
    path: "/plan.md",
    content: "LATEST_B",
    revision: 2,
    humanRevision: 2,
    source: "human",
    status: "paused",
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <PlanPanel sessionID={id} directory="/project" />, host)
  try {
    await vi.waitFor(() => expect(host.textContent).toContain("恢复原执行"))
    ;[...host.querySelectorAll("button")].find((button) => button.textContent === "恢复原执行")!.click()
    await vi.waitFor(() =>
      expect(http.posts.find((item) => item.url.includes("/plan/start"))?.body).toEqual({
        model: { providerID: "fixture", modelID: "large" },
        variant: "reasoning",
      }),
    )
  } finally {
    dispose()
    host.remove()
    http.plan = undefined
    setState("providers", undefined)
  }
})
