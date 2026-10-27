import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import type { Message, Part } from "@merakcode/sdk/client"
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

/** One conversation whose reply changed the given number of files */
function conversation(sessionID: string, files: number) {
  const user = { id: "u1", sessionID, role: "user", time: { created: 10 } } as Message
  const reply = { id: "a1", sessionID, role: "assistant", parentID: "u1", time: { created: 11 } } as Message
  setState("sessions", "message", sessionID, [user, reply])
  setState("sessions", "part", "u1", [{ id: "p0", sessionID, messageID: "u1", type: "text", text: "做登录" } as Part])
  setState(
    "sessions",
    "part",
    "a1",
    Array.from({ length: files }, (_, index) => edit(sessionID, index)),
  )
  setState("sessions", "session_status", sessionID, { type: "idle" })
}

function edit(sessionID: string, index: number): Part {
  const file = `/p/f${index}.ts`
  return {
    id: `e${index}`,
    sessionID,
    messageID: "a1",
    type: "tool",
    tool: "edit",
    callID: `c${index}`,
    state: {
      status: "completed",
      input: { filePath: file },
      metadata: { filediff: { file, before: "", after: "x\n" } },
    },
  } as unknown as Part
}

test("a turn's changed files stay folded and show their totals", () => {
  conversation("c1", 3)
  const host = mount(() => <Messages sessionID="c1" directory="/p" onReviewTurn={() => {}} onReviewFile={() => {}} />)
  const card = host.querySelector(".changes-card")!
  expect(card.querySelector("button.changes-toggle")!.getAttribute("aria-expanded")).toBe("false")
  expect(card.querySelectorAll(".change-file")).toHaveLength(0)
  expect(card.textContent).toContain("本轮改动")
  expect(card.textContent).toContain("3 个文件")
  expect(card.textContent).toContain("审阅")
})

test("opening the changes lists every changed file", () => {
  conversation("c2", 8)
  const host = mount(() => <Messages sessionID="c2" directory="/p" onReviewTurn={() => {}} onReviewFile={() => {}} />)
  const card = host.querySelector(".changes-card")!
  const toggle = card.querySelector<HTMLButtonElement>("button.changes-toggle")!
  toggle.click()
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
  expect(card.querySelectorAll(".change-file")).toHaveLength(8)
  for (let index = 0; index < 8; index++) expect(card.textContent).toContain(`f${index}.ts`)
})

test("closing the changes hides the file list again", () => {
  conversation("c3", 2)
  const host = mount(() => <Messages sessionID="c3" directory="/p" onReviewTurn={() => {}} onReviewFile={() => {}} />)
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
  const host = mount(() => <Messages sessionID="c4" directory="/p" onReviewTurn={() => {}} onReviewFile={() => {}} />)
  host.querySelector<HTMLButtonElement>("button.changes-toggle")!.click()
  const style = getComputedStyle(host.querySelector(".change-list")!)
  expect(style.maxHeight).toBe("180px")
  expect([style.overflow, style.overflowY]).toContain("auto")
})

test("Review in the folded header opens review without expanding the list", () => {
  conversation("c5", 2)
  let reviewed = ""
  const host = mount(() => (
    <Messages
      sessionID="c5"
      directory="/p"
      onReviewTurn={(messageID) => (reviewed = messageID)}
      onReviewFile={() => {}}
    />
  ))
  const card = host.querySelector(".changes-card")!
  const review = [...card.querySelectorAll("button")].find((button) => button.textContent === "审阅")!
  review.click()
  expect(reviewed).toBe("u1")
  expect(card.querySelectorAll(".change-file")).toHaveLength(0)
  expect(card.querySelector("button.changes-toggle")!.getAttribute("aria-expanded")).toBe("false")
})

test("a streaming update keeps an opened changes list open", () => {
  conversation("c6", 2)
  const host = mount(() => <Messages sessionID="c6" directory="/p" onReviewTurn={() => {}} onReviewFile={() => {}} />)
  const card = host.querySelector(".changes-card")!
  const toggle = card.querySelector<HTMLButtonElement>("button.changes-toggle")!
  toggle.click()
  expect(card.querySelectorAll(".change-file")).toHaveLength(2)
  setState("sessions", "part", "a1", 2, edit("c6", 2))
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
  expect(card.querySelectorAll(".change-file")).toHaveLength(3)
  expect(card.textContent).toContain("3 个文件")
})
