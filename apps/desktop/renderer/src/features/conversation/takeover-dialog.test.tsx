import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { TakeoverDialog } from "./takeover-dialog"
import { MerakCodeError } from "@merakcode/sdk/errors"

let cleanup = () => {}
beforeEach(() => setLocale("zh"))
afterEach(() => cleanup())

test("declining takeover never accepts and waits for the decision to persist", async () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const decisions: string[] = []
  let finish = () => {}
  const dispose = render(
    () => (
      <TakeoverDialog
        open
        productTitle="Claude Code"
        onDecision={(decision) => {
          decisions.push(decision)
          return new Promise<void>((resolve) => {
            finish = resolve
          })
        }}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  const dialog = document.querySelector('[role="dialog"]')!
  const decline = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "暂不接管")!
  decline.click()
  expect(decisions).toEqual(["decline"])
  expect(decline.disabled).toBe(true)
  const accept = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "由 MerakCode 接管")!
  accept.click()
  expect(decisions).toEqual(["decline"])
  finish()
  await Promise.resolve()
})

test("a failed takeover decision retains its error code and remains retryable", async () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <TakeoverDialog
        open
        productTitle="Claude Code"
        onDecision={async () => {
          throw new MerakCodeError({ code: "MRK-1004", message: "Synthetic takeover failure" })
        }}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  const dialog = document.querySelector('[role="dialog"]')!
  const accept = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "由 MerakCode 接管")!
  accept.click()
  await expect.poll(() => dialog.querySelector('[role="alert"]')?.textContent).toContain("Synthetic takeover failure")
  expect(dialog.textContent).toContain("MRK-1004")
  expect(accept.disabled).toBe(false)
})

test("Escape dismisses takeover as a refusal", async () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const decisions: string[] = []
  const dispose = render(
    () => (
      <TakeoverDialog
        open
        productTitle="Codex"
        onDecision={async (decision) => {
          decisions.push(decision)
        }}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  await Promise.resolve()
  document
    .querySelector('[role="dialog"]')!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await Promise.resolve()
  expect(decisions).toEqual(["decline"])
})
