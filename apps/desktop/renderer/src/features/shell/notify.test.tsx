import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { connect, listen } from "../../state/store"
import { Notify } from "./notify"

let env: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  env = await engineFixture({ replies: Array.from({ length: 8 }, () => ({ text: "Feedback received" })) })
  location.href = env.url
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})

test("a foreground completion is suppressed before a later background completion", async () => {
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
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={Notify} />
      </Router>
    ),
    host,
  )
  const finished: string[] = []
  const unlisten = listen((_directory, event) => {
    if (event.type === "turn.finished" && event.scope.session) finished.push(event.scope.session)
  })
  const disconnect = connect()
  try {
    const connection = await client()
    const first = (await connection.session.create({ provider: "fake", model: "test", workdir: env.project })).session
    await connection.session.send({ session: first, parts: [{ text: "Foreground" }] })
    await expect.poll(() => finished, { timeout: 20_000 }).toContain(first)
    expect(sent).toEqual([])
    focus.mockReturnValue(false)
    const second = (await connection.session.create({ provider: "fake", model: "test", workdir: env.project })).session
    await connection.session.send({ session: second, parts: [{ text: "Background" }] })
    await expect.poll(() => sent, { timeout: 20_000 }).toEqual(["对话完成"])
    expect(finished).toContain(second)
  } finally {
    disconnect()
    unlisten()
    dispose()
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
