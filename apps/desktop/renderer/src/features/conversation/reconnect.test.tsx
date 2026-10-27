import type { GlobalEvent, PermissionRequest, Session } from "@merakcode/sdk/client"
import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterEach, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { client } from "../../state/client"
import { connect, setState } from "../../state/store"
import { Conversation } from "./page"

const fixture = vi.hoisted(() => ({
  session: undefined as Session | undefined,
  permissions: [] as PermissionRequest[],
  snapshotGate: undefined as Promise<void> | undefined,
  snapshotStarted: false,
}))
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (url: string) => {
    const path = new URL(url).pathname
    const permissions = [...fixture.permissions]
    if (path === "/permission") {
      fixture.snapshotStarted = true
      await fixture.snapshotGate
    }
    const body =
      path === "/project/current"
        ? { id: "global", worktree: "/reconnect", sandboxes: [], time: { created: 1, updated: 1 } }
        : path === "/session"
          ? [fixture.session]
          : path === "/permission"
            ? permissions
            : path === "/session/status"
              ? {}
              : []
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  },
}))
let cleanup = () => {}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  fixture.snapshotGate = undefined
  fixture.snapshotStarted = false
  setState("folders", [])
  window.history.replaceState({}, "", "/")
})

test("reconnecting removes cancelled approvals while retaining another execution's pending request", async () => {
  setLocale("zh")
  const info: Session = {
    id: "reconnect-chat",
    slug: "chat",
    projectID: "global",
    directory: "/reconnect",
    title: "Reconnect",
    version: "1",
    time: { created: 1, updated: 1 },
  }
  fixture.session = info
  const old: PermissionRequest = {
    id: "a-old-request",
    sessionID: info.id,
    executionID: "old",
    permission: "bash",
    patterns: ["old-command"],
    metadata: { command: "old-command" },
  }
  const live: PermissionRequest = {
    id: "b-live-request",
    sessionID: info.id,
    executionID: "live",
    permission: "bash",
    patterns: ["live-command"],
    metadata: { command: "live-command" },
  }
  fixture.permissions = [live]
  setState("folders", [{ directory: "/reconnect" }])
  setState("sessions", "session", [info])
  setState("sessions", "permission", info.id, [old, live])
  setState("sessions", "message", info.id, [])
  setState("loaded", info.id, true)
  let reconnect: (() => void) | undefined
  let end: (() => void) | undefined
  async function* stream(): AsyncGenerator<GlobalEvent> {
    yield { directory: "global", payload: { type: "server.connected", properties: {} } }
    await new Promise<void>((resolve) => {
      reconnect = resolve
    })
    yield { directory: "global", payload: { type: "server.connected", properties: {} } }
    await new Promise<void>((resolve) => {
      end = resolve
    })
  }
  vi.spyOn(client().global, "event").mockResolvedValue({ stream: stream() })
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={() => <Conversation id={info.id} directory="/reconnect" />} />
      </Router>
    ),
    host,
  )
  const disconnect = connect()
  cleanup = () => {
    end?.()
    reconnect?.()
    disconnect()
    dispose()
    host.remove()
  }
  expect(host.textContent).toContain("old-command")
  await vi.waitFor(() => expect(reconnect).toBeTypeOf("function"))
  reconnect!()
  await vi.waitFor(() => expect(host.textContent).not.toContain("old-command"))
  expect(host.textContent).toContain("live-command")
  expect(host.textContent).not.toContain("还有 1 个待审批")
})

test("a pending-request event received during a reconnect snapshot is preserved", async () => {
  setLocale("zh")
  const info: Session = {
    id: "snapshot-chat",
    slug: "chat",
    projectID: "global",
    directory: "/reconnect",
    title: "Snapshot",
    version: "1",
    time: { created: 1, updated: 1 },
  }
  fixture.session = info
  fixture.permissions = []
  let releaseSnapshot = () => {}
  fixture.snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve
  })
  const old: PermissionRequest = {
    id: "z-old",
    sessionID: info.id,
    permission: "bash",
    patterns: ["old-command"],
    metadata: { command: "old-command" },
  }
  const next: PermissionRequest = {
    id: "a-next",
    sessionID: info.id,
    permission: "bash",
    patterns: ["new-command"],
    metadata: { command: "new-command" },
  }
  setState("folders", [{ directory: "/reconnect" }])
  setState("sessions", "session", [info])
  setState("sessions", "permission", info.id, [old])
  setState("sessions", "message", info.id, [])
  setState("loaded", info.id, true)
  let reconnect: (() => void) | undefined
  let publish: (() => void) | undefined
  let end: (() => void) | undefined
  async function* stream(): AsyncGenerator<GlobalEvent> {
    yield { directory: "global", payload: { type: "server.connected", properties: {} } }
    await new Promise<void>((resolve) => {
      reconnect = resolve
    })
    yield { directory: "global", payload: { type: "server.connected", properties: {} } }
    await new Promise<void>((resolve) => {
      publish = resolve
    })
    yield { directory: "/reconnect", payload: { type: "permission.asked", properties: next } }
    await new Promise<void>((resolve) => {
      end = resolve
    })
  }
  vi.spyOn(client().global, "event").mockResolvedValue({ stream: stream() })
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={() => <Conversation id={info.id} directory="/reconnect" />} />
      </Router>
    ),
    host,
  )
  const disconnect = connect()
  cleanup = () => {
    releaseSnapshot()
    publish?.()
    end?.()
    reconnect?.()
    disconnect()
    dispose()
    host.remove()
  }
  await vi.waitFor(() => expect(reconnect).toBeTypeOf("function"))
  reconnect!()
  await vi.waitFor(() => expect(fixture.snapshotStarted).toBe(true))
  publish!()
  await vi.waitFor(() => expect(host.textContent).toContain("new-command"))
  releaseSnapshot()
  await vi.waitFor(() => expect(host.textContent).not.toContain("还有 1 个待审批"))
  expect(host.textContent).toContain("new-command")
})
