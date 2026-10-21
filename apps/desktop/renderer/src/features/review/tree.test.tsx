import type { ReviewFile } from "@merakcode/sdk/client"
import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, expect, test, vi } from "vitest"
import { setLocale, t } from "../../i18n"
import { present } from "./present"
import { ReviewTree } from "./tree"

const file = (name: string): ReviewFile => ({
  file: name,
  status: "modified",
  additions: 1,
  deletions: 0,
  hunks: 1,
  accepted: 0,
  version: "v",
})

let cleanup = () => {}

afterEach(() => {
  cleanup()
  cleanup = () => {}
  vi.useRealTimers()
})

function mount(node: () => JSX.Element) {
  setLocale("zh")
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(node, host)
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host
}

function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new InputEvent("input", { bubbles: true }))
}

test("the file list search keeps paths that contain the query", () => {
  const host = mount(() => <ReviewTree files={[file("src/math.js"), file("src/new.js")]} onOpen={() => {}} />)
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${t("review.searchFiles")}"]`)
  expect(input).toBeTruthy()
  type(input!, "MATH")
  const names = [...host.querySelectorAll(".rt-file")].map((button) => button.textContent)
  expect(names.some((name) => name?.includes("src/math.js"))).toBe(true)
  expect(names.some((name) => name?.includes("src/new.js"))).toBe(false)
  type(input!, "missing")
  expect(host.querySelector(".rt-file")).toBeNull()
  expect(host.textContent).toContain(t("review.noFileMatch"))
})

test("presenting a file centers it and highlights it until the highlight fades", () => {
  vi.useFakeTimers()
  const section = document.createElement("section")
  section.dataset.file = "src/math.js"
  document.body.append(section)
  cleanup = () => section.remove()
  const seen: unknown[] = []
  section.scrollIntoView = (options) => {
    seen.push(options)
  }
  present(section)
  expect(section.classList.contains("flash")).toBe(true)
  expect(seen).toEqual([{ block: "center", behavior: "smooth" }])
  vi.advanceTimersByTime(1500)
  expect(section.classList.contains("flash")).toBe(false)
})
