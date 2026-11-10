import type { EngineEvent } from "@merakcode/sdk"
import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { GroupUsage } from "./usage"

test("groups usage by task and member without mixing currencies or dropping unknown cost", () => {
  setLocale("en")
  const fact = (id: string, member: string, currency: string, cost: number, known: boolean): EngineEvent => ({
    id,
    stream: "session:s",
    seq: Number(id),
    scope: { group: "g", task: "t", session: "s" },
    time: "2026-11-10T00:00:00Z",
    type: "turn.finished",
    actor: { kind: "agent", id: member },
    payload: {
      stop: "answered",
      usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, currency, cost, costKnown: known },
    },
  })
  const first = fact("1", "member-a", "USD", 1.25, true)
  const host = document.createElement("div")
  const dispose = render(
    () => (
      <GroupUsage
        events={[
          first,
          first,
          fact("2", "member-a", "CNY", 3, true),
          fact("3", "member-a", "", 0, false),
          fact("4", "member-b", "USD", 0, true),
        ]}
        members={[]}
        tasks={[]}
      />
    ),
    host,
  )
  try {
    const headers = [...host.querySelectorAll("th")].map((item) => item.textContent)
    expect(headers).toContain("USD")
    expect(headers).toContain("CNY")
    const rows = [...host.querySelectorAll("tbody tr")]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain("member-a")
    expect(rows[0]!.textContent).toContain("300")
    expect(rows[0]!.textContent).toContain("60")
    expect(rows[0]!.textContent).toContain("1.25")
    expect(rows[0]!.textContent).toContain("3.00")
    expect(rows[0]!.textContent).toContain("Unknown")
    expect(rows[1]!.textContent).toContain("0.00")
  } finally {
    dispose()
  }
})
