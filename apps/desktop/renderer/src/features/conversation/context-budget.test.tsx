import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { ContextBudget } from "./context-budget"
import { watchConversation, type Conversation } from "@merakcode/sdk"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"

test("renders context segments with readable values and no overlapping cache segment", () => {
  setLocale("en")
  const host = document.createElement("div")
  const dispose = render(
    () => (
      <ContextBudget
        report={{
          system: 100,
          tools: 200,
          messages: 300,
          reserve: 100,
          total: 700,
          window: 1000,
          cacheRead: 120,
          cacheWrite: 10,
          purpose: "reply",
        }}
      />
    ),
    host,
  )
  try {
    expect(host.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("700")
    expect(host.querySelector('[role="meter"]')?.getAttribute("aria-valuemax")).toBe("1000")
    expect(host.querySelectorAll("[data-segment]")).toHaveLength(5)
    expect(host.textContent).toContain("Messages: 300")
    expect(host.textContent).toContain("Available: 300")
    expect(host.textContent).toContain("Cache read tokens: 120")
  } finally {
    dispose()
  }
})

test("restores the latest context budget when reopening a completed conversation", async () => {
  const engine = await engineFixture()
  let stop: (() => Promise<void>) | undefined
  try {
    location.href = engine.url
    const connection = await client()
    const created = await connection.session.create({ provider: "fake", model: "fixture", workdir: engine.project })
    let current: Conversation | undefined
    const latest = () => current
    stop = (
      await watchConversation(connection, created.session, (value) => {
        current = value
      })
    ).close
    await connection.session.send({ session: created.session, parts: [{ text: "Measure context" }] })
    await expect.poll(() => current?.state.status).toBe("done")
    const budget = current?.budget
    expect(budget).toBeDefined()
    await stop()
    current = undefined
    stop = (
      await watchConversation(connection, created.session, (value) => {
        current = value
      })
    ).close
    expect(latest()?.budget).toEqual(budget)
  } finally {
    await stop?.()
    await (await client()).close()
    await engine.close()
  }
}, 30_000)
