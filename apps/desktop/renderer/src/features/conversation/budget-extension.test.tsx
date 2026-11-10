import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { client } from "../../state/client"
import { ensureSession, setState, state } from "../../state/store"
import { engineFixture } from "../../test/engine"
import { Conversation } from "./page"

test("requires consent before extending an exhausted conversation budget", async () => {
  const engine = await engineFixture({ replies: [{ text: "First", usage: { input: 12 } }, { text: "Second" }] })
  const host = document.createElement("div")
  document.body.append(host)
  let dispose = () => {}
  try {
    location.href = engine.url
    setLocale("en")
    const connection = await client()
    const created = await connection.session.create({
      provider: "fake",
      model: "fixture",
      workdir: engine.project,
      budget: { maxTokens: 10 },
    })
    setState("connected", true)
    setState("config", { providers: { fake: { hasKey: true } } })
    setState("models", [
      {
        provider: "fake",
        id: "fixture",
        window: 32000,
        maxOutput: 2048,
        source: "builtin",
        thinking: [],
        caps: { tools: true, vision: false, pdf: false },
        price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ])
    await ensureSession(created.session)
    await connection.session.send({ session: created.session, parts: [{ text: "Start" }] })
    await expect.poll(() => state.views[created.session]?.error, { timeout: 5000 }).toBe("MRK-4005")
    dispose = render(
      () => (
        <Router>
          <Route path="*" component={() => <Conversation id={created.session} directory={engine.project} />} />
        </Router>
      ),
      host,
    )
    const consent = host.querySelector<HTMLInputElement>(
      'input[aria-label="Add one profile budget for the next message"]',
    )
    expect(consent).not.toBeNull()
    expect(consent!.checked).toBe(false)
    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(true)
    consent!.click()
    expect(consent!.checked).toBe(true)
    expect(input.disabled).toBe(false)
    input.value = "Continue"
    input.dispatchEvent(new InputEvent("input", { bubbles: true }))
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(false)
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await expect.poll(() => state.views[created.session]?.state.budgetExtensions, { timeout: 5000 }).toBe(1)
    await expect.poll(() => host.textContent, { timeout: 5000 }).toContain("Second")
  } finally {
    dispose()
    host.remove()
    await (await client()).close()
    await engine.close()
  }
}, 30_000)
