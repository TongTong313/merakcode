import { render } from "solid-js/web"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { engineFixture } from "../../test/engine"
import { setLocale, t } from "../../i18n"
import { client } from "../../state/client"
import { openPanel, selectPanels } from "./workspace"
import { Panel } from "./panel"

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
            listeners.forEach((listener) => listener())
          },
          onDidChangeContent: (listener: () => void) => listeners.push(listener),
          dispose() {},
        }
      },
    },
  },
}))

let env: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})
/** A conversation the engine really knows, working in the fixture project. */
const chat = async () =>
  (await (await client()).session.create({ provider: "fake", model: "test", workdir: env.project })).session

test("the chooser hides each open singleton and restores it after closing", async () => {
  setLocale("en")
  window.requestIdleCallback = (callback) =>
    window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 0)
  window.cancelIdleCallback = window.clearTimeout
  localStorage.clear()
  const sessionID = await chat()
  await selectPanels({ directory: env.project, sessionID })
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <Panel sessionID={sessionID} directory={env.project} folder={env.project} />, host)
  try {
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0)
    const add = host.querySelector<HTMLButtonElement>('[aria-label="New tab"]')!
    expect(add).not.toBeNull()
    for (const kind of ["git", "review", "plan"]) {
      host.querySelector<HTMLButtonElement>(`[data-panel-kind="${kind}"]`)!.click()
      await vi.waitFor(() => expect(host.querySelectorAll('[role="tab"]')).toHaveLength(1))
      add.click()
      expect(host.querySelector(`[data-panel-kind="${kind}"]`)).toBeNull()
      for (const other of ["git", "review", "plan"].filter((value) => value !== kind))
        expect(host.querySelector(`[data-panel-kind="${other}"]`)).not.toBeNull()
      host
        .querySelector<HTMLButtonElement>(
          `[aria-label="${t("panel.closeTab", { name: t(`panel.${kind}` as "panel.git") })}"]`,
        )!
        .click()
      await vi.waitFor(() => expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0))
      expect(host.querySelector(`[data-panel-kind="${kind}"]`)).not.toBeNull()
    }
  } finally {
    dispose()
    host.remove()
  }
})

test("promotion blocks a pending discard dialog outside the editor portal", async () => {
  setLocale("en")
  const directory = env.project
  const sessionID = await chat()
  const owner = await selectPanels({ directory, sessionID })
  await openPanel({ kind: "git", view: { commit: "keep this message" } })
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <Panel sessionID={sessionID} directory={directory} folder={directory} />, host)
  try {
    host.querySelector<HTMLButtonElement>(`[aria-label="${t("panel.closeTab", { name: t("panel.git") })}"]`)!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    owner.transfer(true)
    const discard = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) =>
      button.textContent?.includes("Discard"),
    )!
    expect(discard.disabled).toBe(true)
    discard.click()
    expect(owner.state.tabs).toHaveLength(1)
  } finally {
    owner.transfer(false)
    dispose()
    host.remove()
  }
})
