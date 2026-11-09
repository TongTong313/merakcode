import { render } from "solid-js/web"
import { afterEach, expect, test } from "vitest"
import { setLocale, t } from "../../i18n"
import { Toasts } from "../../ui/toast"
import { setState } from "../../state/store"
import { choice } from "../../state/models"
import { Composer, type Submission } from "./composer"

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.replaceChildren()
})

function mount(submit: (value: Submission) => Promise<void> | void) {
  setLocale("en")
  setState("config", { providers: { fake: { hasKey: true } } })
  setState("models", [
    {
      provider: "fake",
      id: "model",
      window: 32000,
      maxOutput: 2048,
      source: "builtin",
      thinking: ["off", "high"],
      caps: { tools: true, vision: true, pdf: true },
      price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ])
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => (
      <>
        <Composer directory="/workspace" busy={false} onSubmit={submit} />
        <Toasts />
      </>
    ),
    host,
  )
  return host.querySelector("textarea")!
}

test("allows selecting full takeover before starting a conversation", () => {
  mount(() => {})
  const picker = document.querySelector<HTMLButtonElement>('button[aria-label="Permission level"]')
  expect(picker).not.toBeNull()
  expect(picker!.textContent).toContain("Ask every time")
  picker!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes("Full takeover"),
  )
  expect(option).toBeDefined()
  option!.click()
  expect(choice(undefined, "/workspace").mode).toBe("takeover")
})

test("sends on Enter but preserves composition and Shift Enter", async () => {
  const sent: Submission[] = []
  const input = mount((value) => {
    sent.push(value)
  })
  input.value = "Hello"
  input.dispatchEvent(new InputEvent("input", { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }))
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, shiftKey: true }))
  expect(sent).toHaveLength(0)
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(sent).toEqual([{ text: "Hello", files: [] }])
  expect(input.value).toBe("")
})

test("preserves the draft when sending fails", async () => {
  const input = mount(async () => {
    throw new Error("MRK-1001")
  })
  input.value = "Keep this"
  input.dispatchEvent(new InputEvent("input", { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(input.value).toBe("Keep this")
})

test("rejects attachments when their combined decoded size exceeds two MiB", async () => {
  const sent: Submission[] = []
  mount((value) => {
    sent.push(value)
  })
  const drop = (size: number, name: string) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File([new Uint8Array(size)], name, { type: "image/png" }))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    input.files = dataTransfer.files
    input.dispatchEvent(new Event("change", { bubbles: true }))
  }
  drop(1024 * 1024, "first.png")
  await expect.poll(() => document.querySelectorAll(".composer-files .attachment").length).toBe(1)
  drop(1100 * 1024, "second.png")
  await expect.poll(() => document.body.textContent).toContain(t("prompt.attachmentLimit"))
  document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click()
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]!.files.map((file) => file.filename)).toEqual(["first.png"])
})
