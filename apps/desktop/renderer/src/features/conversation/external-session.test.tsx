import type {
  AgentConnectionProduct,
  ExternalAssistantMessage,
  ExternalUserMessage,
  GlobalEvent,
  Session,
} from "@merakcode/sdk/client"
import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { produce } from "solid-js/store"
import { applyEvent } from "@merakcode/sdk/store"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { connect, listen, session, setState } from "../../state/store"
import { client } from "../../state/client"
import { Messages } from "./messages"
import { Conversation } from "./page"
import { refreshConnections } from "../../state/agent-connections"
import { connectionDefaults } from "./product.fixture"

const transport = vi.hoisted(() => ({
  info: undefined as Session | undefined,
  decisions: [] as string[],
  revisions: [] as number[],
  gate: undefined as Promise<void> | undefined,
  responses: 0,
  products: [] as AgentConnectionProduct[],
  takeoverStatus: 200,
  sessionGate: undefined as Promise<void> | undefined,
  sessionRequests: 0,
  sessionResponses: 0,
}))
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (url: string, init?: { body?: ArrayBuffer }) => {
    let body: unknown = []
    if (String(url).includes("/takeover")) {
      const input = JSON.parse(new TextDecoder().decode(init?.body))
      transport.decisions.push(input.decision)
      transport.revisions.push(input.expectedTargetRevision)
      if (transport.takeoverStatus === 409)
        return new Response(
          JSON.stringify({ name: "TakeoverConflictError", code: "MRK-4007", data: { message: "The target changed" } }),
          { status: 409, headers: { "content-type": "application/json" } },
        )
      transport.info = {
        ...transport.info!,
        targetRevision: input.expectedTargetRevision + 1,
        ...(input.decision === "accept"
          ? {
              target: { kind: "merak" },
              targetBlock: undefined,
              takeover: { at: 1, fromProductID: "claude", blockID: input.blockID },
            }
          : { targetBlock: { ...transport.info!.targetBlock!, decision: "declined" } }),
      }
      body = transport.info
      await transport.gate
      transport.responses++
    } else if (String(url).includes("/agent-connection/product")) body = transport.products
    else if (/\/session\/locked(?:\?|$)/.test(String(url))) {
      body = structuredClone(transport.info)
      transport.sessionRequests++
      await transport.sessionGate
      transport.sessionResponses++
    }
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  },
}))

let cleanup = () => {}
beforeEach(() => setLocale("zh"))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  transport.decisions = []
  transport.revisions = []
  transport.gate = undefined
  transport.responses = 0
  transport.products = []
  transport.takeoverStatus = 200
  transport.sessionGate = undefined
  transport.sessionRequests = 0
  transport.sessionResponses = 0
  window.history.replaceState({}, "", "/")
})

test.each([
  ["refresh", "accept"],
  ["refresh", "decline"],
  ["event", "accept"],
  ["event", "decline"],
] as const)("a delayed %s cannot overwrite a takeover decision (%s)", async (source, decision) => {
  const info: Session = {
    id: "locked",
    slug: "locked",
    projectID: "global",
    directory: "/project",
    title: "Locked",
    version: "1",
    time: { created: 1, updated: 1 },
    target: { kind: "external", productID: "claude" },
    targetRevision: 1,
    targetBlock: { blockID: "b1", productID: "claude", disabledCycleID: "d1", decision: "pending" },
  }
  setState("sessions", "session", [info])
  setState("sessions", "message", info.id, [])
  setState("loaded", info.id, true)
  transport.info = structuredClone(info)
  const stale = structuredClone(info)
  const refresh = Promise.withResolvers<void>()
  const end = Promise.withResolvers<void>()
  const received = Promise.withResolvers<void>()
  const unlisten = listen((_directory, event) => {
    if (event.type === "session.updated" && event.properties.info.targetRevision === 1) received.resolve()
  })
  transport.sessionGate = refresh.promise
  async function* stream(): AsyncGenerator<GlobalEvent> {
    if (source === "refresh") yield { directory: "global", payload: { type: "config.updated", properties: {} } }
    else {
      await refresh.promise
      yield {
        directory: "/project",
        payload: { type: "session.updated", properties: { sessionID: info.id, info: stale } },
      }
    }
    await end.promise
  }
  vi.spyOn(client().global, "event").mockResolvedValue({ stream: stream() })
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={() => <Conversation id={info.id} directory="/project" />} />
      </Router>
    ),
    host,
  )
  const disconnect = connect()
  cleanup = () => {
    refresh.resolve()
    end.resolve()
    unlisten()
    disconnect()
    dispose()
    host.remove()
  }
  if (source === "refresh") await vi.waitFor(() => expect(transport.sessionRequests).toBe(1))
  const decide = [...document.querySelector('[role="dialog"]')!.querySelectorAll("button")].find(
    (button) => button.textContent === (decision === "accept" ? "由 MerakCode 接管" : "暂不接管"),
  )!
  decide.click()
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  refresh.resolve()
  if (source === "refresh") await vi.waitFor(() => expect(transport.sessionResponses).toBe(1))
  else await received.promise
  expect(session(info.id)?.targetRevision).toBe(2)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  if (decision === "decline") expect(session(info.id)?.targetBlock?.decision).toBe("declined")
  if (decision === "accept") {
    expect(session(info.id)?.target).toEqual({ kind: "merak" })
    expect(session(info.id)?.targetBlock).toBeUndefined()
  }
})

test("a late conflict refresh cannot overwrite a newer pending takeover", async () => {
  const info: Session = {
    id: "locked",
    slug: "locked",
    projectID: "global",
    directory: "/project",
    title: "Locked",
    version: "1",
    time: { created: 1, updated: 1 },
    target: { kind: "external", productID: "claude" },
    targetRevision: 1,
    targetBlock: { blockID: "b1", productID: "claude", disabledCycleID: "d1", decision: "pending" },
  }
  setState("sessions", "session", [info])
  setState("sessions", "message", info.id, [])
  setState("loaded", info.id, true)
  transport.info = { ...info, targetRevision: 2, targetBlock: { ...info.targetBlock!, decision: "declined" } }
  transport.takeoverStatus = 409
  const refresh = Promise.withResolvers<void>()
  transport.sessionGate = refresh.promise
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={() => <Conversation id={info.id} directory="/project" />} />
      </Router>
    ),
    host,
  )
  cleanup = () => {
    refresh.resolve()
    dispose()
    host.remove()
  }
  const decline = () =>
    [...document.querySelector('[role="dialog"]')!.querySelectorAll("button")].find(
      (button) => button.textContent === "暂不接管",
    )!
  decline().click()
  await vi.waitFor(() => expect(transport.sessionRequests).toBe(1))
  const next: Session = {
    ...info,
    targetRevision: 9,
    targetBlock: { blockID: "b2", productID: "claude", disabledCycleID: "d2", decision: "pending" },
  }
  setState(
    "sessions",
    produce((draft) => applyEvent(draft, { type: "session.updated", properties: { sessionID: info.id, info: next } })),
  )
  refresh.resolve()
  await vi.waitFor(() => expect(transport.sessionResponses).toBe(1))
  expect(session(info.id)?.targetRevision).toBe(9)
  expect(session(info.id)?.targetBlock?.blockID).toBe("b2")
  transport.takeoverStatus = 200
  transport.info = next
  decline().click()
  await vi.waitFor(() => expect(transport.revisions).toEqual([1, 9]))
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
})

test.each(["pending", "declined"] as const)(
  "a valid conflict refresh preserves its %s decision state",
  async (decision) => {
    const info: Session = {
      id: "locked",
      slug: "locked",
      projectID: "global",
      directory: "/project",
      title: "Locked",
      version: "1",
      time: { created: 1, updated: 1 },
      target: { kind: "external", productID: "claude" },
      targetRevision: 1,
      targetBlock: { blockID: "b1", productID: "claude", disabledCycleID: "d1", decision: "pending" },
    }
    setState("sessions", "session", [info])
    setState("sessions", "message", info.id, [])
    setState("loaded", info.id, true)
    transport.info = {
      ...info,
      targetRevision: 2,
      targetBlock: { blockID: "b2", productID: "claude", disabledCycleID: "d2", decision },
    }
    transport.takeoverStatus = 409
    const host = document.createElement("div")
    document.body.appendChild(host)
    const dispose = render(
      () => (
        <Router>
          <Route path="/" component={() => <Conversation id={info.id} directory="/project" />} />
        </Router>
      ),
      host,
    )
    cleanup = () => {
      dispose()
      host.remove()
    }
    const accept = () =>
      [...document.querySelector('[role="dialog"]')!.querySelectorAll("button")].find(
        (button) => button.textContent === "由 MerakCode 接管",
      )!
    accept().click()
    await vi.waitFor(() => expect(transport.sessionResponses).toBe(1))
    expect(session(info.id)?.target).toEqual({ kind: "external", productID: "claude" })
    expect(session(info.id)?.targetRevision).toBe(2)
    expect(transport.decisions).toEqual(["accept"])
    if (decision === "pending") expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    if (decision === "declined") {
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      ;[...host.querySelectorAll("button")].find((button) => button.textContent === "由 MerakCode 接管")!.click()
    }
    transport.takeoverStatus = 200
    accept().click()
    await vi.waitFor(() => expect(transport.revisions).toEqual([1, 2]))
    await vi.waitFor(() => expect(host.textContent).toContain("已由 MerakCode 接管"))
  },
)

test.each([
  ["zh", "完成后输出"],
  ["en", "Output on completion"],
] as const)("a direct conversation describes non-streaming output in %s", async (locale, label) => {
  setLocale(locale)
  const product: AgentConnectionProduct = {
    ...connectionDefaults,
    id: "command",
    title: "Command",
    connected: true,
    enabled: true,
    builtin: false,
    source: "global",
  }
  transport.products = [product]
  await refreshConnections()
  const info: Session = {
    id: "command-view",
    slug: "command-view",
    projectID: "global",
    directory: "/project",
    title: "Command",
    version: "1",
    time: { created: 1, updated: 1 },
    target: { kind: "external", productID: product.id },
  }
  setState("sessions", "session", [info])
  setState("sessions", "message", info.id, [])
  setState("loaded", info.id, true)
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={() => <Conversation id={info.id} directory="/project" />} />
      </Router>
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  const status = () => host.querySelector('[role="status"]')!
  expect(status().textContent).toContain(label)
  transport.products = [{ ...product, capabilities: { ...product.capabilities, textStreaming: true } }]
  await refreshConnections()
  expect(status().textContent).not.toContain(label)
  transport.products = [{ ...product, connected: false }]
  await refreshConnections()
  expect(status().textContent).not.toContain(label)
})

test("an external reply keeps its product and model signature and does not offer native history actions", () => {
  const sessionID = "external-view"
  const execution = {
    kind: "external" as const,
    productID: "claude",
    productTitle: "Claude Code",
    runID: "r1",
    targetRevision: 0,
    actualModel: { id: "haiku" },
  }
  const user: ExternalUserMessage = {
    id: "eu1",
    sessionID,
    role: "user",
    time: { created: 1 },
    permissionMode: "ask",
    execution,
  }
  const reply: ExternalAssistantMessage = {
    id: "ea1",
    sessionID,
    role: "assistant",
    parentID: user.id,
    time: { created: 2, completed: 3 },
    path: { cwd: "/project", root: "/project" },
    execution,
    terminal: "completed",
  }
  setState("sessions", "message", sessionID, [user, reply])
  setState("sessions", "part", user.id, [{ id: "ep1", sessionID, messageID: user.id, type: "text", text: "Hello" }])
  setState("sessions", "part", reply.id, [
    { id: "ep2", sessionID, messageID: reply.id, type: "text", text: "External answer" },
  ])
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => <Messages sessionID={sessionID} directory="/project" onReviewTurn={() => {}} onReviewFile={() => {}} />,
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  expect(host.textContent).toContain("Claude Code · haiku")
  expect(host.textContent).toContain("External answer")
  expect(host.querySelector('[aria-label="编辑"]')).toBeNull()
  expect(host.querySelector('[aria-label="重试"]')).toBeNull()
})

test("a disabled external conversation locks input and persists a refusal through the SDK", async () => {
  const info: Session = {
    id: "locked",
    slug: "locked",
    projectID: "global",
    directory: "/project",
    title: "Locked",
    version: "1",
    time: { created: 1, updated: 1 },
    target: { kind: "external", productID: "claude" },
    targetRevision: 1,
    targetBlock: { blockID: "b1", productID: "claude", disabledCycleID: "d1", decision: "pending" },
  }
  transport.info = info
  setState("sessions", "session", [info])
  setState("sessions", "message", info.id, [])
  setState("loaded", info.id, true)
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={() => <Conversation id={info.id} directory="/project" />} />
      </Router>
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  expect(host.querySelector("textarea")!.disabled).toBe(true)
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  const decline = [...document.querySelectorAll("button")].find((button) => button.textContent === "暂不接管")!
  decline.click()
  await vi.waitFor(() => expect(transport.decisions).toEqual(["decline"]))
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  expect(host.querySelector("textarea")!.disabled).toBe(true)
  expect(host.textContent).toContain("由 MerakCode 接管")
})

test("a late takeover response cannot overwrite a newer session revision", async () => {
  const info: Session = {
    id: "locked",
    slug: "locked",
    projectID: "global",
    directory: "/project",
    title: "Locked",
    version: "1",
    time: { created: 1, updated: 1 },
    target: { kind: "external", productID: "claude" },
    targetRevision: 1,
    targetBlock: { blockID: "b1", productID: "claude", disabledCycleID: "d1", decision: "pending" },
  }
  transport.info = info
  let release = () => {}
  transport.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  setState("sessions", "session", [info])
  setState("sessions", "message", info.id, [])
  setState("loaded", info.id, true)
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={() => <Conversation id={info.id} directory="/project" />} />
      </Router>
    ),
    host,
  )
  cleanup = () => {
    release()
    dispose()
    host.remove()
  }
  ;[...document.querySelectorAll("button")].find((button) => button.textContent === "暂不接管")!.click()
  await vi.waitFor(() => expect(transport.decisions).toHaveLength(1))
  setState(
    "sessions",
    produce((draft) =>
      applyEvent(draft, {
        type: "session.updated",
        properties: {
          sessionID: info.id,
          info: { ...info, targetRevision: 9, targetBlock: { ...info.targetBlock!, decision: "declined" } },
        },
      }),
    ),
  )
  transport.gate = undefined
  release()
  await vi.waitFor(() => expect(transport.responses).toBe(1))
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  await Promise.resolve()
  ;[...host.querySelectorAll("button")].find((button) => button.textContent === "由 MerakCode 接管")!.click()
  ;[...document.querySelectorAll("button")].find((button) => button.textContent === "暂不接管")!.click()
  await vi.waitFor(() => expect(transport.decisions).toHaveLength(2))
  expect(transport.revisions).toEqual([1, 9])
})

test.each([
  ["cycle", "decline"],
  ["cycle", "accept"],
  ["cycle", "escape"],
  ["session", "decline"],
] as const)(
  "a new pending takeover remains actionable for %s/%s after an older decision returns",
  async (scope, decision) => {
    const info: Session = {
      id: "locked",
      slug: "locked",
      projectID: "global",
      directory: "/project",
      title: "Locked",
      version: "1",
      time: { created: 1, updated: 1 },
      target: { kind: "external", productID: "claude" },
      targetRevision: 1,
      targetBlock: { blockID: "b1", productID: "claude", disabledCycleID: "d1", decision: "pending" },
    }
    transport.info = info
    const first = Promise.withResolvers<void>()
    transport.gate = first.promise
    setState("sessions", "session", [info])
    setState("sessions", "message", info.id, [])
    setState("loaded", info.id, true)
    const [selected, setSelected] = createSignal(info.id)
    const host = document.createElement("div")
    document.body.appendChild(host)
    const dispose = render(
      () => (
        <Router>
          <Route path="/" component={() => <Conversation id={selected()} directory="/project" />} />
        </Router>
      ),
      host,
    )
    cleanup = () => {
      first.resolve()
      dispose()
      host.remove()
    }
    const dialog = () => document.querySelector('[role="dialog"]')!
    const decline = () => [...dialog().querySelectorAll("button")].find((button) => button.textContent === "暂不接管")!
    decline().click()
    await vi.waitFor(() => expect(transport.decisions).toEqual(["decline"]))
    const next: Session = {
      ...info,
      id: scope === "session" ? "locked-next" : info.id,
      targetRevision: 9,
      targetBlock: { blockID: "b2", productID: "claude", disabledCycleID: "d2", decision: "pending" },
    }
    transport.info = next
    setState("sessions", "message", next.id, [])
    setState("loaded", next.id, true)
    setState(
      "sessions",
      produce((draft) =>
        applyEvent(draft, { type: "session.updated", properties: { sessionID: next.id, info: next } }),
      ),
    )
    setSelected(next.id)
    transport.gate = undefined
    first.resolve()
    await vi.waitFor(() => expect(transport.responses).toBe(1))
    await vi.waitFor(() => expect(decline().disabled).toBe(false))
    if (decision === "escape")
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    if (decision === "decline") decline().click()
    if (decision === "accept")
      [...dialog().querySelectorAll("button")].find((button) => button.textContent === "由 MerakCode 接管")!.click()
    await vi.waitFor(() => expect(transport.revisions).toEqual([1, 9]))
    expect(transport.decisions).toEqual(["decline", decision === "accept" ? "accept" : "decline"])
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    if (decision === "accept") expect(host.textContent).toContain("已由 MerakCode 接管")
    if (decision !== "accept") expect(host.querySelector("textarea")!.disabled).toBe(true)
  },
)
