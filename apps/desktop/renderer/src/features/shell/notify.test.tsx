import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { expect, test, vi } from "vitest"
import type { GlobalEvent } from "@merakcode/sdk/client"
import { client } from "../../state/client"
import { connect, listen } from "../../state/store"
import { setLocale } from "../../i18n"
import { Notify } from "./notify"

test("a dispatched foreground completion is suppressed before a later background completion", async () => {
  setLocale("zh")
  const sent: string[] = []
  vi.stubGlobal(
    "Notification",
    class {
      constructor(title: string) {
        sent.push(title)
      }
    },
  )
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true)
  let controller!: ReadableStreamDefaultController<GlobalEvent>
  const events = new ReadableStream<GlobalEvent>({
    start(value) {
      controller = value
    },
  })
  vi.spyOn(client().global, "event").mockResolvedValue({ stream: events as unknown as AsyncGenerator<GlobalEvent> })
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={Notify} />
      </Router>
    ),
    host,
  )
  const handled = Promise.withResolvers<void>()
  const unlisten = listen((_directory, event) => {
    if (event.type === "session.idle" && event.properties.sessionID === "foreground") handled.resolve()
  })
  const disconnect = connect()
  try {
    controller.enqueue({
      directory: "/project",
      payload: { type: "session.idle", properties: { sessionID: "foreground" } },
    })
    await handled.promise
    expect(sent).toEqual([])
    focus.mockReturnValue(false)
    controller.enqueue({
      directory: "/project",
      payload: { type: "session.idle", properties: { sessionID: "background" } },
    })
    await expect.poll(() => sent).toEqual(["对话完成"])
  } finally {
    controller.close()
    disconnect()
    unlisten()
    dispose()
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
