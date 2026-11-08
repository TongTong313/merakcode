import { render } from "solid-js/web"
import { afterEach, expect, test } from "vitest"
import { setLocale } from "../i18n"
import { toast, Toasts } from "./toast"

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.replaceChildren()
})

test.each([
  ["en", "Engine connection failed", "Check that the engine is running"],
  ["zh", "引擎连接失败", "检查引擎是否运行"],
] as const)("renders a coded engine failure in %s", (language, title, hint) => {
  setLocale(language)
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <Toasts />, host)
  toast({ kind: "error", title: "MRK-1001", error: new Error("MRK-1001") })
  expect(host.textContent).toContain(title)
  expect(host.textContent).toContain(hint)
  expect(host.textContent).toContain("MRK-1001")
})
