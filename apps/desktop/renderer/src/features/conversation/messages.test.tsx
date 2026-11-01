import type { Message, Part } from "@merakcode/sdk/client"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { Messages } from "./messages"

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII="

let cleanup = () => {}
beforeEach(() => setLocale("zh"))
afterEach(() => {
  cleanup()
  cleanup = () => {}
})

function renderSentImage(sessionID: string) {
  const messageID = `u-${sessionID}`
  const message = { id: messageID, sessionID, role: "user", time: { created: 1 } } as Message
  setState("sessions", "message", sessionID, [message])
  setState("sessions", "part", messageID, [
    {
      id: `p-${sessionID}`,
      sessionID,
      messageID,
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: png,
    } as Part,
  ])
  setState("sessions", "session_status", sessionID, { type: "idle" })
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Messages sessionID={sessionID} directory={`/${sessionID}`} onReviewTurn={() => {}} onReviewFile={() => {}} />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host
}

test("a sent image attachment keeps its thumbnail and opens the full image", async () => {
  const host = renderSentImage("image-message")
  expect(host.querySelector(".user-message .attachments img")?.getAttribute("src")).toBe(png)
  host.querySelector<HTMLButtonElement>('[aria-label="查看图片 shot.png"]')!.click()
  await vi.waitFor(() => expect(document.querySelector("[role=dialog] img")?.getAttribute("src")).toBe(png))
  document.querySelector<HTMLButtonElement>("[role=dialog] .dialog-foot button")!.click()
  await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull())
})

test("clicking a sent image's name opens the full image", async () => {
  const host = renderSentImage("image-message-name")
  const name = host.querySelector(".user-message .attachments .ellipsis")
  if (!name) throw new Error("attachment name did not render")
  name.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector("[role=dialog] img")?.getAttribute("src")).toBe(png))
  document.querySelector<HTMLButtonElement>("[role=dialog] .dialog-foot button")!.click()
  await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull())
})
