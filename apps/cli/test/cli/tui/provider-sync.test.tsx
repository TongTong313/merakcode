import { expect, test } from "vitest"
import { testRender } from "@opentui/solid"
import type { GlobalEvent } from "@merakcode/sdk/client"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider, type EventSource } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { LocaleProvider } from "../../../src/cli/cmd/tui/context/locale"
import { LocalProvider, useLocal } from "../../../src/cli/cmd/tui/context/local"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"
import { setTimeout as delay } from "node:timers/promises"

function Probe() {
  const sync = useSync()
  return <text>{sync.data.status}</text>
}

function ModelProbe() {
  const local = useLocal()
  const model = local.model.current()
  return <text>{model ? model.providerID + "/" + model.modelID : "missing"}</text>
}

/**
 * Waits for async SDK data to render. Flushes first so the current frame finishes: opentui rejects capturing a frame
 * while rendering (OutputBusy)
 */
async function frameContaining(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    await setup.flush()
    const frame = setup.captureCharFrame()
    if (frame.includes(text)) return frame
    await delay(5)
  }
  await setup.flush()
  return setup.captureCharFrame()
}

test("only provider changed refreshes the TUI provider catalog", async () => {
  const requests: string[] = []
  let emit: ((event: GlobalEvent) => void) | undefined
  const events: EventSource = {
    subscribe: async (handler) => {
      emit = handler
      return () => undefined
    },
  }
  const json = (value: unknown) => Response.json(value)
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(url.pathname)
    if (url.pathname.endsWith("/config/providers")) return json({ providers: [], default: {} })
    if (url.pathname.endsWith("/provider")) return json({ all: [], default: {}, connected: [] })
    if (url.pathname.endsWith("/path")) {
      return json({ state: "", config: "", data: "", worktree: "", home: "", directory: "/project" })
    }
    if (url.pathname.includes("/session/status")) return json({})
    if (url.pathname.includes("/session")) return json([])
    if (url.pathname.includes("/mcp/status")) return json({})
    if (url.pathname.includes("/experimental/resource")) return json({})
    if (url.pathname.includes("/provider/auth")) return json({})
    if (url.pathname.includes("/vcs")) return json({ branch: "main" })
    return json([])
  }) as typeof fetch
  const setup = await testRender(
    () => (
      <SDKProvider url="http://localhost" directory="/project" fetch={fetcher} events={events}>
        <ProjectProvider>
          <ArgsProvider>
            <ExitProvider>
              <SyncProvider>
                <Probe />
              </SyncProvider>
            </ExitProvider>
          </ArgsProvider>
        </ProjectProvider>
      </SDKProvider>
    ),
    { width: 20, height: 2 },
  )

  try {
    for (let attempt = 0; attempt < 20 && (!emit || !requests.some((path) => path.endsWith("/provider"))); attempt++) {
      await setup.flush()
      await delay(5)
    }
    if (!emit) throw new Error("event source did not subscribe")
    const count = () => requests.filter((path) => path.endsWith("/provider")).length
    const initial = count()

    emit({
      directory: "global",
      payload: { type: "lsp.updated", properties: {} },
    })
    await delay(25)
    await setup.flush()
    expect(count()).toBe(initial)

    emit({
      directory: "global",
      payload: { type: "provider.changed", properties: { reason: "refreshed" } },
    })
    await delay(25)
    await setup.flush()
    expect(count()).toBe(initial + 1)
  } finally {
    setup.renderer.destroy()
  }
})

test("refreshing an unchanged provider catalog keeps the current TUI model selected", async () => {
  let emit: ((event: GlobalEvent) => void) | undefined
  let gate: Promise<void> | undefined
  let release: (() => void) | undefined
  const events: EventSource = {
    subscribe: async (handler) => {
      emit = handler
      return () => undefined
    },
  }
  const provider = {
    id: "alibaba-cn",
    name: "Alibaba Cloud",
    source: "custom",
    env: [],
    options: {},
    models: {
      first: { id: "first", providerID: "alibaba-cn", name: "First" },
      second: { id: "second", providerID: "alibaba-cn", name: "Second" },
    },
  }
  const json = (value: unknown) => Response.json(value)
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname.endsWith("/config/providers")) {
      await gate
      return json({ providers: [provider], default: { "alibaba-cn": "first" } })
    }
    if (url.pathname.endsWith("/provider")) {
      await gate
      return json({ all: [provider], default: { "alibaba-cn": "first" }, connected: [] })
    }
    if (url.pathname.endsWith("/agent")) {
      return json([{ id: "build", name: "Build", mode: "primary", hidden: false }])
    }
    if (url.pathname.endsWith("/config")) return json({})
    if (url.pathname.endsWith("/path")) {
      return json({ state: "", config: "", data: "", worktree: "", home: "", directory: "/project" })
    }
    if (url.pathname.includes("/session/status")) return json({})
    if (url.pathname.includes("/session")) return json([])
    if (url.pathname.includes("/mcp/status")) return json({})
    if (url.pathname.includes("/experimental/resource")) return json({})
    if (url.pathname.includes("/provider/auth")) return json({})
    if (url.pathname.includes("/vcs")) return json({ branch: "main" })
    return json([])
  }) as typeof fetch
  const setup = await testRender(
    () => (
      <KVProvider>
        <ToastProvider>
          <SDKProvider url="http://localhost" directory="/project" fetch={fetcher} events={events}>
            <ProjectProvider>
              <ArgsProvider model="alibaba-cn/second">
                <ExitProvider>
                  <SyncProvider>
                    <ThemeProvider mode="dark">
                      <LocaleProvider>
                        <LocalProvider>
                          <ModelProbe />
                        </LocalProvider>
                      </LocaleProvider>
                    </ThemeProvider>
                  </SyncProvider>
                </ExitProvider>
              </ArgsProvider>
            </ProjectProvider>
          </SDKProvider>
        </ToastProvider>
      </KVProvider>
    ),
    { width: 30, height: 2 },
  )

  try {
    expect(await frameContaining(setup, "alibaba-cn/second")).toContain("alibaba-cn/second")
    if (!emit) throw new Error("event source did not subscribe")
    gate = new Promise<void>((done) => (release = done))

    emit({
      directory: "global",
      payload: { type: "provider.changed", properties: { reason: "refreshed" } },
    })
    await delay(10)
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("alibaba-cn/second")

    release?.()
    gate = undefined
    await delay(25)
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("alibaba-cn/second")
  } finally {
    setup.renderer.destroy()
  }
})

test("user model selection is persisted to global config.model so a TUI restart restores it", async () => {
  const patches: unknown[] = []
  const provider = {
    id: "alibaba-cn",
    name: "Alibaba Cloud",
    source: "custom",
    env: [],
    options: {},
    models: {
      first: { id: "first", providerID: "alibaba-cn", name: "First" },
      second: { id: "second", providerID: "alibaba-cn", name: "Second" },
    },
  }
  const json = (value: unknown) => Response.json(value)
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input.toString(), init)
    const url = new URL(request.url)
    if (request.method === "PATCH" && url.pathname.endsWith("/global/config")) {
      patches.push(await request.json())
      return json({})
    }
    if (url.pathname.endsWith("/config/providers"))
      return json({ providers: [provider], default: { "alibaba-cn": "first" } })
    if (url.pathname.endsWith("/provider"))
      return json({ all: [provider], default: { "alibaba-cn": "first" }, connected: [] })
    if (url.pathname.endsWith("/agent")) return json([{ id: "build", name: "Build", mode: "primary", hidden: false }])
    if (url.pathname.endsWith("/config")) return json({ model: "alibaba-cn/first" })
    if (url.pathname.endsWith("/path")) {
      return json({ state: "", config: "", data: "", worktree: "", home: "", directory: "/project" })
    }
    if (url.pathname.includes("/session/status")) return json({})
    if (url.pathname.includes("/session")) return json([])
    if (url.pathname.includes("/mcp/status")) return json({})
    if (url.pathname.includes("/experimental/resource")) return json({})
    if (url.pathname.includes("/provider/auth")) return json({})
    if (url.pathname.includes("/vcs")) return json({ branch: "main" })
    return json([])
  }) as typeof fetch
  let local: ReturnType<typeof useLocal> | undefined
  function Capture() {
    local = useLocal()
    return <ModelProbe />
  }
  const events: EventSource = { subscribe: async () => () => undefined }
  const setup = await testRender(
    () => (
      <KVProvider>
        <ToastProvider>
          <SDKProvider url="http://localhost" directory="/project" fetch={fetcher} events={events}>
            <ProjectProvider>
              <ArgsProvider>
                <ExitProvider>
                  <SyncProvider>
                    <ThemeProvider mode="dark">
                      <LocaleProvider>
                        <LocalProvider>
                          <Capture />
                        </LocalProvider>
                      </LocaleProvider>
                    </ThemeProvider>
                  </SyncProvider>
                </ExitProvider>
              </ArgsProvider>
            </ProjectProvider>
          </SDKProvider>
        </ToastProvider>
      </KVProvider>
    ),
    { width: 30, height: 2 },
  )

  try {
    expect(await frameContaining(setup, "alibaba-cn/first")).toContain("alibaba-cn/first")

    // Sets such as session restore or command-line arguments do not write the global config
    local!.model.set({ providerID: "alibaba-cn", modelID: "second" })
    await delay(10)
    expect(patches).toEqual([])

    // An explicit pick in the model dialog writes the global config
    local!.model.set({ providerID: "alibaba-cn", modelID: "second" }, { recent: true, persist: true })
    for (let attempt = 0; attempt < 40 && patches.length === 0; attempt++) await delay(5)
    expect(patches).toEqual([{ model: "alibaba-cn/second" }])
    expect(local!.model.current()).toEqual({ providerID: "alibaba-cn", modelID: "second" })
  } finally {
    setup.renderer.destroy()
  }
})
