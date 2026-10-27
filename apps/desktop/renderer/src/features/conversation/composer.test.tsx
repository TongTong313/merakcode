import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { Composer } from "./composer"
import { send } from "./send"
import { setState } from "../../state/store"
import { Toasts } from "../../ui/toast"

let cleanup = () => {}
beforeEach(() => setLocale("zh"))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test("a disabled composer keeps its draft and prevents typing or sending", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const [disabled, setDisabled] = createSignal(false)
  const submissions: unknown[] = []
  const dispose = render(
    () => (
      <Composer
        directory="/composer-lock-test"
        busy={false}
        disabled={disabled()}
        draft={{ text: "Keep this draft", files: [] }}
        onSubmit={(submission) => void submissions.push(submission)}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  const input = host.querySelector("textarea")!
  setDisabled(true)
  expect(input.disabled).toBe(true)
  expect(input.value).toBe("Keep this draft")
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  expect(submissions).toEqual([])
  expect(host.querySelector<HTMLButtonElement>('[aria-label="附件"]')?.disabled).toBe(true)
  setDisabled(false)
  expect(input.disabled).toBe(false)
  expect(input.value).toBe("Keep this draft")
})

test("a composer discards an attachment from before a lock even after input is enabled again", () => {
  let finish: (() => void) | undefined
  vi.stubGlobal(
    "FileReader",
    class {
      result = "data:text/plain;base64,c2VjcmV0"
      onload?: () => void
      readAsDataURL() {
        finish = () => this.onload?.()
      }
    },
  )
  const host = document.createElement("div")
  document.body.appendChild(host)
  const [disabled, setDisabled] = createSignal(false)
  const dispose = render(
    () => <Composer directory="/composer-drop-test" busy={false} disabled={disabled()} onSubmit={() => {}} />,
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  const event = new Event("drop", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["secret"], "blocked.txt")] } })
  host.querySelector(".composer")!.dispatchEvent(event)
  expect(finish).toBeTypeOf("function")
  setDisabled(true)
  setDisabled(false)
  finish!()
  expect(host.textContent).not.toContain("blocked.txt")
})

test("an external text composer does not require a native model or offer attachments", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => <Composer directory="/external-composer-test" busy={false} external onSubmit={() => {}} />,
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  expect(host.textContent).not.toContain("还没有连接模型")
  expect(host.querySelector('[aria-label="附件"]')).toBeNull()
})

test.each([
  ["attachment", "zh", "MRK-4008"],
  ["attachment", "en", "MRK-4008"],
  ["disabled", "zh", "MRK-4006"],
  ["disabled", "en", "MRK-4006"],
  ["imported", "zh", "MRK-4008"],
  ["imported", "en", "MRK-4008"],
] as const)(
  "an external %s rejection in %s shows its error code and preserves the draft",
  async (reason, locale, code) => {
    setLocale(locale)
    const sessionID = `external-${reason}-error-${locale}`
    const directory = "/external-attachment-error"
    setState("sessions", "session", [
      {
        id: sessionID,
        slug: sessionID,
        projectID: "global",
        directory,
        title: "External attachment",
        version: "1",
        time: { created: 1, updated: 1 },
        target: { kind: "external", productID: "claude" },
        ...(reason === "disabled"
          ? {
              targetBlock: {
                blockID: "disabled-block",
                productID: "claude",
                disabledCycleID: "disabled-cycle",
                decision: "declined" as const,
              },
            }
          : {}),
        ...(reason === "imported" ? { readOnlyReason: "imported-external-history" as const } : {}),
      },
    ])
    const host = document.createElement("div")
    document.body.appendChild(host)
    const dispose = render(
      () => (
        <>
          <Composer
            sessionID={sessionID}
            directory={directory}
            busy={false}
            external
            draft={{
              text: "Keep this draft",
              files: [{ type: "file", mime: "text/plain", filename: "draft.txt", url: "file:///project/draft.txt" }],
            }}
            onSubmit={(submission) => send(sessionID, directory, submission)}
          />
          <Toasts />
        </>
      ),
      host,
    )
    cleanup = () => {
      host.querySelectorAll<HTMLButtonElement>(".toast > button:last-child").forEach((button) => button.click())
      dispose()
      host.remove()
    }
    host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await vi.waitFor(() => expect(host.querySelector(".toasts")?.textContent).toContain(code))
    const copyLabel =
      locale === "zh" ? "复制详情（反馈问题时附上）" : "Copy details (attach them when reporting a problem)"
    expect(host.querySelector<HTMLButtonElement>(`.toasts [aria-label="${copyLabel}"]`)).not.toBeNull()
    expect(host.querySelector("textarea")!.value).toBe("Keep this draft")
    expect(host.querySelector(".composer-files")?.textContent).toContain("draft.txt")
  },
)
