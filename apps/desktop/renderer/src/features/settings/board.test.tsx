import { render } from "solid-js/web"
import { afterAll, beforeAll, expect, test } from "vitest"
import { setLocale, t } from "../../i18n"
import { client } from "../../state/client"
import { connect, state } from "../../state/store"
import { engineFixture } from "../../test/engine"
import { BoardSettings } from "./board"

let engine: Awaited<ReturnType<typeof engineFixture>>
let stop = () => {}
beforeAll(async () => {
  engine = await engineFixture()
  location.href = engine.url
  setLocale("en")
  stop = connect()
  await client()
})
afterAll(async () => {
  stop()
  await engine.close()
})

test("the auto-archive days of the board are read from the engine and changed in place", async () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(() => <BoardSettings />, host)
  try {
    const choice = (days: number) =>
      [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) =>
        item.textContent?.includes(days ? t("settings.board.days", { days }) : t("settings.board.off")),
      )
    await expect.poll(() => choice(3)?.getAttribute("aria-checked"), { timeout: 10000 }).toBe("true")
    choice(14)!.click()
    await expect
      .poll(async () => (await (await client()).config.get()).board.autoArchiveDays, { timeout: 10000 })
      .toBe(14)
    await expect.poll(() => state.config?.board.autoArchiveDays).toBe(14)
    await expect.poll(() => choice(14)?.getAttribute("aria-checked")).toBe("true")
    choice(0)!.click()
    await expect
      .poll(async () => (await (await client()).config.get()).board.autoArchiveDays, { timeout: 10000 })
      .toBe(0)
  } finally {
    dispose()
    host.remove()
  }
})
