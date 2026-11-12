import fixture from "../../../../../../schema/testdata/session.json"
import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { createConversation, SessionStateSchema } from "@merakcode/sdk"
import { setState } from "../../state/store"
import { setLocale } from "../../i18n"
import { Messages } from "./messages"

test("renders the Go conversation fixture with tool cards and the final answer", () => {
  setLocale("en")
  setState("views", "golden", createConversation(SessionStateSchema.parse(fixture.state)))
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <Messages sessionID="golden" directory="/workspace" />, host)
  try {
    expect(host.textContent).toContain("Read note.txt")
    expect(host.textContent).toContain("The note is ready.")
    const tool = host.querySelector<HTMLButtonElement>(".tool-card-head")!
    expect(tool.textContent).toContain("note.txt")
    tool.click()
    expect(host.textContent).toContain("A note from the workspace.")
  } finally {
    dispose()
    host.remove()
  }
})

test("keeps intermediate work together and copies only the final answer", () => {
  setLocale("en")
  const view = createConversation(SessionStateSchema.parse(fixture.state))
  view.state.messages = [
    { role: "user", parts: [{ text: "Check the file" }] },
    { role: "assistant", parts: [{ text: "I will inspect it." }] },
    { role: "assistant", parts: [{ toolCall: { id: "read", name: "read_file", input: { path: "note.txt" } } }] },
    { role: "tool", parts: [{ toolResult: { callId: "read", parts: [{ text: "hello" }] } }] },
    { role: "assistant", parts: [{ text: "The file is ready." }] },
  ]
  setState("views", "grouped", createConversation(view.state))
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <Messages sessionID="grouped" directory="/workspace" />, host)
  try {
    const work = host.querySelector("details.turn-work")
    expect(work).not.toBeNull()
    expect(work?.textContent).toContain("I will inspect it.")
    expect(work?.textContent).not.toContain("The file is ready.")
    // One copy button for the turn, and it takes the final answer, not the work before it
    expect(host.querySelectorAll('[aria-label="Copy"]')).toHaveLength(1)
    expect(host.querySelector('.user-turn [aria-label="Copy"]')).toBeNull()
  } finally {
    dispose()
    host.remove()
  }
})

test("the copy button of a turn writes the final answer to the clipboard and not the work before it", async () => {
  setLocale("en")
  const written: string[] = []
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void written.push(text) },
  })
  const view = createConversation(SessionStateSchema.parse(fixture.state))
  view.state.messages = [
    { role: "user", parts: [{ text: "Check the file" }] },
    { role: "assistant", parts: [{ text: "I will inspect it." }] },
    { role: "assistant", parts: [{ toolCall: { id: "read", name: "read_file", input: { path: "note.txt" } } }] },
    { role: "tool", parts: [{ toolResult: { callId: "read", parts: [{ text: "hello" }] } }] },
    { role: "assistant", parts: [{ text: "The file is ready." }] },
  ]
  setState("views", "copying", createConversation(view.state))
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <Messages sessionID="copying" directory="/workspace" />, host)
  try {
    host.querySelector<HTMLButtonElement>('.turn-actions [aria-label="Copy"]')!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(written).toEqual(["The file is ready."])
  } finally {
    dispose()
    host.remove()
  }
})
