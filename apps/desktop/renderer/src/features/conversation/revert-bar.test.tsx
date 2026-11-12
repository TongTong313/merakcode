import fixture from "../../../../../../schema/testdata/session.json"
import { render } from "solid-js/web"
import { afterEach, expect, test } from "vitest"
import { createConversation, SessionStateSchema } from "@merakcode/sdk"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { RevertBar } from "./revert-bar"

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.replaceChildren()
})

function mount(id: string, patch: { hidden?: boolean; status?: string }) {
  setLocale("en")
  const state = SessionStateSchema.parse(fixture.state)
  const view = createConversation({
    ...state,
    status: patch.status ?? "idle",
    ...(patch.hidden ? { hidden: { index: 0, messages: [{ role: "user", parts: [{ text: "gone" }] }] } } : {}),
  })
  setState("views", id, view)
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <RevertBar sessionID={id} />, host)
  return host
}

test("offers to restore what was reverted, and says that a new message makes it final", () => {
  const host = mount("reverted", { hidden: true })
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Reverted")
  expect(host.querySelector("button")?.textContent).toBe("Restore")
})

test("shows nothing when nothing was reverted", () => {
  expect(mount("clean", {}).querySelector("button")).toBeNull()
})

test("shows nothing while a turn is running, because a revert cannot be undone then", () => {
  expect(mount("busy", { hidden: true, status: "running" }).querySelector("button")).toBeNull()
})
