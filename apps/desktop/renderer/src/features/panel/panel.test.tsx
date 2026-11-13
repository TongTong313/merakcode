import { render } from "solid-js/web"
import { expect, test, vi } from "vitest"
import { setLocale, t } from "../../i18n"
import { openPanel, selectPanels } from "./workspace"
import { Panel } from "./panel"

test("the chooser hides each open singleton and restores it after closing", async () => {
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

test("only the selected tab exposes its close button to the keyboard and the panel has no close control", async () => {
  setLocale("en")
  window.requestIdleCallback = (callback) =>
    window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 0)
  window.cancelIdleCallback = window.clearTimeout
  localStorage.clear()
  await selectPanels({ directory: "/panel-close", sessionID: crypto.randomUUID() })
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <Panel directory="/panel-close" folder="/panel-close" />, host)
  try {
    host.querySelector<HTMLButtonElement>('[data-panel-kind="git"]')!.click()
    await vi.waitFor(() => expect(host.querySelectorAll('[role="tab"]')).toHaveLength(1))
    host.querySelector<HTMLButtonElement>('[aria-label="New tab"]')!.click()
    host.querySelector<HTMLButtonElement>('[data-panel-kind="plan"]')!.click()
    await vi.waitFor(() => expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2))
    expect(host.querySelector('[aria-label="Close panel"]')).toBeNull()
    const close = (kind: "git" | "plan") =>
      host.querySelector<HTMLElement>(
        `[aria-label="${t("panel.closeTab", { name: t(`panel.${kind}` as "panel.git") })}"]`,
      )
    expect(close("plan")!.getAttribute("tabindex")).toBe("0")
    expect(close("git")!.getAttribute("tabindex")).toBe("-1")
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
