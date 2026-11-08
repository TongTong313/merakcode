import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, expect, test } from "vitest"
import type { EngineEvent } from "@merakcode/sdk"
import { setLocale } from "../../i18n"
import { Question } from "./dock"

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.replaceChildren()
})

const question = (id: string, text: string): Extract<EngineEvent, { type: "question.asked" }> => ({
  id,
  stream: "session:test",
  seq: 5,
  time: "2026-11-08T00:00:00Z",
  scope: { session: "test" },
  actor: { kind: "agent" },
  type: "question.asked",
  payload: { text, options: ["Blue", "Green"] },
})

test("a replacement question clears the previous answer and disables empty submission", () => {
  setLocale("en")
  const [request, setRequest] = createSignal(question("first", "First question"))
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <Question request={request()} />, host)
  const submit = () =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Submit")!
  expect(submit().disabled).toBe(true)
  host.querySelector<HTMLButtonElement>(".question-option")!.click()
  expect(host.querySelector("input")!.value).toBe("Blue")
  expect(submit().disabled).toBe(false)
  setRequest(question("second", "Second question"))
  expect(host.textContent).toContain("Second question")
  expect(host.querySelector("input")!.value).toBe("")
  expect(submit().disabled).toBe(true)
})
