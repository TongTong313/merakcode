import { render } from "solid-js/web"
import { expect, test, vi } from "vitest"
import { PlanCard } from "./plan"
import { setLocale } from "../../i18n"

vi.mock("undici", () => ({
  Agent: class {},
  fetch: async () =>
    new Response(
      JSON.stringify({
        sessionID: "ses_plan",
        path: "/plan.md",
        content: "Plan",
        revision: 1,
        humanRevision: 0,
        source: "agent",
        status: "review",
      }),
      { headers: { "content-type": "application/json" } },
    ),
}))

test("the session plan card presents one plan and opens the existing editor", async () => {
  setLocale("zh")
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <PlanCard sessionID="ses_plan" directory="/project" />, host)
  try {
    await vi.waitFor(() => expect(host.textContent).toContain("计划已生成"))
    expect(host.textContent).toContain("待审核")
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
