import { createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, expect, test } from "vitest"
import type { ToolPart } from "@merakcode/sdk/client"
import "../../styles/tokens.css"
import "../../styles/base.css"
import "../../styles/app.css"
import { setLocale, t } from "../../i18n"
import { Tool } from "./tools"

let cleanup = () => {}

afterEach(() => {
  cleanup()
  cleanup = () => {}
})

function mount(node: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(node, host)
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host
}

/** A finished shell command, as the conversation renders it */
function bash(
  command: string,
  fields: { output?: string; exit?: number; start?: number; end?: number } = {},
): ToolPart {
  return {
    id: "tool-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "tool",
    callID: "call-1",
    tool: "bash",
    state: {
      status: "completed",
      input: { command },
      output: fields.output ?? "",
      title: "",
      metadata: { output: fields.output ?? "", exit: fields.exit },
      time: { start: fields.start ?? 0, end: fields.end ?? 2500 },
    },
  }
}

/** A command still running, with whatever it has printed so far */
function running(command: string, output: string): ToolPart {
  return {
    id: "tool-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "tool",
    callID: "call-1",
    tool: "bash",
    state: {
      status: "running",
      input: { command },
      metadata: { output },
      time: { start: 0 },
    },
  }
}

/** A command the shell rejected */
function failed(command: string, error: string): ToolPart {
  return {
    id: "tool-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "tool",
    callID: "call-1",
    tool: "bash",
    state: {
      status: "error",
      input: { command },
      error,
      time: { start: 0, end: 1000 },
    },
  }
}

/** The block under the title that holds stdout or the error */
function resultOf(host: HTMLElement) {
  const command = host.querySelector("code")
  host.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  const result = host.querySelector("pre")
  expect(command).toBeTruthy()
  expect(result).toBeTruthy()
  expect(command!.compareDocumentPosition(result!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(command!.parentElement!.contains(result!)).toBe(false)
  return { command: command!, result: result! }
}

test("stdout and errors sit in their own block under the command", () => {
  setLocale("zh")
  const command = "pnpm test"
  const output = "Test Files  1 failed\nTests  1 failed | 2 passed"
  const host = mount(() => <Tool part={bash(command, { output, exit: 1 })} directory="D:/work" />)
  const { command: title, result } = resultOf(host)
  expect(title.textContent).toBe(command)
  expect(result.textContent).toBe(output)
  expect(title.parentElement!.textContent).not.toContain("Test Files")

  const message = "not recognized as the name of a cmdlet"
  const failedHost = mount(() => <Tool part={failed(command, message)} directory="D:/work" />)
  const failedView = resultOf(failedHost)
  expect(failedView.command.textContent).toBe(command)
  expect(failedView.result.textContent).toBe(message)
  expect(failedView.command.parentElement!.textContent).toContain(t("tool.failed"))
  expect(getComputedStyle(failedView.result).borderTopWidth).toBe("1px")
})

test("long command output stays complete inside a scrolling region", () => {
  setLocale("zh")
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)
  const host = mount(() => <Tool part={bash("pnpm test", { output: lines.join("\n") })} directory="D:/work" />)
  host.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  const result = host.querySelector("pre")
  expect(result?.textContent).toContain("line 1")
  expect(result?.textContent).toContain("line 40")
  expect(host.textContent).not.toContain(t("review.expand"))
  expect(host.textContent).not.toContain(t("review.collapse"))
  const style = getComputedStyle(result!)
  expect(style.maxHeight).toBe("320px")
  expect([style.overflow, style.overflowY]).toContain("auto")
})

/** Pretend the output region has a real height, which happy-dom does not lay out */
function scrollBox(el: HTMLElement, height: number) {
  let scrollHeight = height
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => height })
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight })
  return {
    grow(next: number) {
      scrollHeight = next
    },
    /** How far the visible bottom is from the end of the output */
    gap() {
      return el.scrollHeight - el.clientHeight - el.scrollTop
    },
  }
}

test("new output follows the tail until the reader scrolls up", () => {
  setLocale("zh")
  const [output, setOutput] = createSignal("line 1")
  const host = mount(() => <Tool part={running("pnpm test", output())} directory="D:/work" />)
  host.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  const result = host.querySelector("pre")
  expect(result).toBeTruthy()
  const box = scrollBox(result!, 320)
  box.grow(2000)
  setOutput(["line 1", "line 2", "line 3"].join("\n"))
  expect(box.gap()).toBeLessThanOrEqual(8)

  result!.scrollTop = 0
  result!.dispatchEvent(new Event("scroll"))
  box.grow(4000)
  setOutput(["line 1", "line 2", "line 3", "line 4"].join("\n"))
  expect(result!.scrollTop).toBe(0)

  result!.scrollTop = result!.scrollHeight - result!.clientHeight
  result!.dispatchEvent(new Event("scroll"))
  box.grow(5000)
  setOutput(["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"))
  expect(result!.textContent).toContain("line 5")
  expect(box.gap()).toBeLessThanOrEqual(8)
})

test("a command starts collapsed and the title expands it", () => {
  setLocale("zh")
  const output = "Test Files  1 failed"
  const host = mount(() => <Tool part={bash("pnpm test", { output })} directory="D:/work" />)
  const title = host.querySelector("button")
  expect(title?.getAttribute("aria-expanded")).toBe("false")
  expect(host.querySelector("pre")).toBeNull()
  title?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  expect(host.querySelector("pre")?.textContent).toBe(output)
  expect(title?.getAttribute("aria-expanded")).toBe("true")
  title?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  expect(host.querySelector("pre")).toBeNull()
  expect(title?.getAttribute("aria-expanded")).toBe("false")
})

test("a finished command shows the command, exit code, and duration in the title", () => {
  setLocale("zh")
  const command = "foreach ($d in 'packages/engine/src','packages/sdk','packages/client-core') { Get-ChildItem $d }"
  const host = mount(() => <Tool part={bash(command, { exit: 2, start: 0, end: 2500 })} directory="D:/work" />)
  const title = [...host.querySelectorAll("code")].find((el) => el.textContent === command)
  const titleButton = title?.closest("button")
  expect(title?.textContent).toBe(command)
  expect(title?.getAttribute("title")).toBe(command)
  expect(titleButton?.hasAttribute("disabled")).toBe(false)
  expect(titleButton?.getAttribute("aria-expanded")).toBeNull()
  expect(host.textContent).not.toContain(t("tool.bash"))
  expect(host.textContent).toContain(t("tool.exit", { code: 2 }))
  expect(host.textContent).toContain("2.5s")
})
