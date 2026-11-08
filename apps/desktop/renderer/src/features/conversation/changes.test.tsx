import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import { createConversation, SessionStateSchema, type ModelMessage } from "@merakcode/sdk"
import fixture from "../../../../../../schema/testdata/session.json"
import "../../styles/tokens.css"
import "../../styles/base.css"
import "../../styles/app.css"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { Messages } from "./messages"

let cleanup = () => {}

beforeEach(() => setLocale("zh"))

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

/** Completed write calls supply file navigation without inventing diff counts. */
function conversation(sessionID: string, files: number) {
  const snapshot = SessionStateSchema.parse(fixture.state)
  snapshot.id = sessionID
  snapshot.messages = [
    { role: "user", parts: [{ text: "Update files" }] },
    ...Array.from({ length: files }, (_, index) => edit(index)).flat(),
    { role: "assistant", parts: [{ text: "Ready" }] },
  ]
  setState("views", sessionID, createConversation(snapshot))
}
function edit(index: number): ModelMessage[] {
  return [
    {
      role: "assistant",
      parts: [
        { toolCall: { id: `c${index}`, name: "write_file", input: { path: `/p/f${index}.ts`, content: "x\n" } } },
      ],
    },
    { role: "tool", parts: [{ toolResult: { callId: `c${index}`, parts: [{ text: "File written." }] } }] },
  ]
}

test("a turn's changed files stay folded and show their totals", () => {
  conversation("c1", 3)
  const host = mount(() => <Messages sessionID="c1" directory="/p" onReview={() => {}} onReviewFile={() => {}} />)
  const card = host.querySelector(".changes-card")!
  expect(card.querySelector("button.changes-toggle")!.getAttribute("aria-expanded")).toBe("false")
  expect(card.querySelectorAll(".change-file")).toHaveLength(0)
  expect(card.textContent).toContain("本轮改动")
  expect(card.textContent).toContain("3 个文件")
  expect(card.textContent).toContain("审阅")
})

test("opening the changes lists every changed file", () => {
  conversation("c2", 8)
  const host = mount(() => <Messages sessionID="c2" directory="/p" onReview={() => {}} onReviewFile={() => {}} />)
  const card = host.querySelector(".changes-card")!
  const toggle = card.querySelector<HTMLButtonElement>("button.changes-toggle")!
  toggle.click()
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
  expect(card.querySelectorAll(".change-file")).toHaveLength(8)
  for (let index = 0; index < 8; index++) expect(card.textContent).toContain(`f${index}.ts`)
})

test("closing the changes hides the file list again", () => {
  conversation("c3", 2)
  const host = mount(() => <Messages sessionID="c3" directory="/p" onReview={() => {}} onReviewFile={() => {}} />)
  const card = host.querySelector(".changes-card")!
  const toggle = card.querySelector<HTMLButtonElement>("button.changes-toggle")!
  toggle.click()
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
  toggle.click()
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  expect(card.querySelectorAll(".change-file")).toHaveLength(0)
})

test("an opened changes list is capped at six rows and scrolls", () => {
  conversation("c4", 8)
  const host = mount(() => <Messages sessionID="c4" directory="/p" onReview={() => {}} onReviewFile={() => {}} />)
  host.querySelector<HTMLButtonElement>("button.changes-toggle")!.click()
  const style = getComputedStyle(host.querySelector(".change-list")!)
  expect(style.maxHeight).toBe("180px")
  expect([style.overflow, style.overflowY]).toContain("auto")
})

test("Review in the folded header opens review without expanding the list", () => {
  conversation("c5", 2)
  let reviewed = ""
  const host = mount(() => (
    <Messages sessionID="c5" directory="/p" onReview={() => (reviewed = "session")} onReviewFile={() => {}} />
  ))
  const card = host.querySelector(".changes-card")!
  const review = [...card.querySelectorAll("button")].find((button) => button.textContent === "审阅")!
  review.click()
  expect(reviewed).toBe("session")
  expect(card.querySelectorAll(".change-file")).toHaveLength(0)
  expect(card.querySelector("button.changes-toggle")!.getAttribute("aria-expanded")).toBe("false")
})

test("a streaming update keeps an opened changes list open", () => {
  conversation("c6", 2)
  const host = mount(() => <Messages sessionID="c6" directory="/p" onReview={() => {}} onReviewFile={() => {}} />)
  const card = host.querySelector(".changes-card")!
  const toggle = card.querySelector<HTMLButtonElement>("button.changes-toggle")!
  toggle.click()
  expect(card.querySelectorAll(".change-file")).toHaveLength(2)
  conversation("c6", 3)
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
  expect(card.querySelectorAll(".change-file")).toHaveLength(3)
  expect(card.textContent).toContain("3 个文件")
})
