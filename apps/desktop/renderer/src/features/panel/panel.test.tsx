import { render } from "solid-js/web"
import { expect, test, vi } from "vitest"
import { setLocale, t } from "../../i18n"
import { openPanel, selectPanels } from "./workspace"
import { Panel } from "./panel"

test("the empty editor offers panel choices and creates distinct tabs", async () => {
  setLocale("en")
  window.requestIdleCallback = (callback) =>
    window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 0)
  window.cancelIdleCallback = window.clearTimeout
  localStorage.clear()
  await selectPanels({ directory: "/test", sessionID: crypto.randomUUID() })
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <Panel directory="/test" folder="/test" />, host)
  try {
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0)
    const add = host.querySelector<HTMLButtonElement>('[aria-label="New tab"]')!
    expect(add).not.toBeNull()
    host.querySelector<HTMLButtonElement>('[data-panel-kind="git"]')!.click()
    await vi.waitFor(() => expect(host.querySelectorAll('[role="tab"]')).toHaveLength(1))
    add.click()
    host.querySelector<HTMLButtonElement>('[data-panel-kind="git"]')!.click()
    await vi.waitFor(() => expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2))
  } finally {
    dispose()
    host.remove()
  }
})

test("promotion blocks a pending discard dialog outside the editor portal", async () => {
  setLocale("en")
  const directory = `/test/${crypto.randomUUID()}`
  const owner = await selectPanels({ directory, sessionID: crypto.randomUUID() })
  await openPanel({ kind: "git", view: { commit: "keep this message" } })
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <Panel directory={directory} folder={directory} />, host)
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
