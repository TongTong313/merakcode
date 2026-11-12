import { render } from "solid-js/web"
import { afterEach, expect, test } from "vitest"
import type { ConfigWarning } from "@merakcode/sdk"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { ConfigWarnings, freshWarnings, warningKey } from "./warnings"

const warning = (path: string, message = "this entry is not valid and is skipped"): ConfigWarning => ({
  code: "MRK-3002",
  path,
  file: "/home/me/merakcode.json",
  message,
})

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.replaceChildren()
})

test("each warning is announced once, and one that has been seen is not announced again", () => {
  const seen = new Set<string>()
  const first = freshWarnings([warning("mcp.a"), warning("mcp.b")], seen)
  expect(first.map((item) => item.path)).toEqual(["mcp.a", "mcp.b"])
  expect(freshWarnings([warning("mcp.a"), warning("mcp.c")], seen).map((item) => item.path)).toEqual(["mcp.c"])
  expect(freshWarnings([warning("mcp.a")], seen)).toEqual([])
})

test("two warnings about different files or paths have different keys", () => {
  expect(warningKey(warning("mcp.a"))).not.toBe(warningKey(warning("mcp.b")))
  expect(warningKey(warning("mcp.a"))).not.toBe(warningKey({ ...warning("mcp.a"), file: "/other.json" }))
})

test("the settings list names the entry, says what is wrong and offers to open the file", () => {
  setLocale("en")
  setState("config", { warnings: [warning("mcp.broken")] } as never)
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <ConfigWarnings />, host)
  expect(host.textContent).toContain("mcp.broken")
  expect(host.textContent).toContain("/home/me/merakcode.json")
  expect(host.querySelector("button")?.textContent).toBe("Open file")
})

test("nothing is listed when the configuration has no warnings", () => {
  setState("config", { warnings: [] } as never)
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <ConfigWarnings />, host)
  expect(host.textContent).toBe("")
})
