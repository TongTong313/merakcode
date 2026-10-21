import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { ProviderLogo } from "./provider-logo"

function mount(node: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(node, host)
  return {
    host,
    cleanup() {
      dispose()
      host.remove()
    },
  }
}

test("a custom provider shows the first letter of its name", () => {
  const view = mount(() => <ProviderLogo id="my-gateway" name=" my gateway " />)
  expect(view.host.textContent).toBe("M")
  view.cleanup()
})

test("a built-in provider shows its logo and no letter", () => {
  const view = mount(() => <ProviderLogo id="openai" name="OpenAI" />)
  expect(view.host.textContent).toBe("")
  const mark = view.host.querySelector("span")
  expect(mark?.getAttribute("style") ?? "").toMatch(/svg/i)
  view.cleanup()
})
