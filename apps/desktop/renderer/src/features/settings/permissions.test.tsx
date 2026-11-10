import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { setState } from "../../state/store"
import { setUi } from "../../state/ui"
import { setLocale } from "../../i18n"
import { Settings } from "./settings"

test("saves three permission modes and confirms full takeover", async () => {
  const engine = await engineFixture()
  const host = document.createElement("div")
  document.body.append(host)
  let dispose = () => {}
  try {
    location.href = engine.url
    setLocale("en")
    setUi("settings", "general")
    const connection = await client()
    setState("config", await connection.config.get())
    dispose = render(() => <Settings />, host)
    const choose = (label: string) => {
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Permission level"]')!
        .dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
      ;[...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((item) => item.textContent?.includes(label))!
        .click()
    }
    await expect.poll(() => host.querySelector('[aria-label="Permission level"]')).not.toBeNull()
    choose("Ask only for risky actions")
    await expect.poll(async () => (await connection.config.get()).mode).toBe("auto")
    choose("Full takeover")
    await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull()
    expect((await connection.config.get()).mode).toBe("auto")
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent === "Cancel")!
      .click()
    expect((await connection.config.get()).mode).toBe("auto")
    choose("Full takeover")
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent === "Enable full takeover")!
      .click()
    await expect.poll(async () => (await connection.config.get()).mode).toBe("takeover")
    choose("Ask every time")
    await expect.poll(async () => (await connection.config.get()).mode).toBe("ask")
  } finally {
    dispose()
    host.remove()
    await (await client()).close()
    await engine.close()
  }
}, 30_000)
