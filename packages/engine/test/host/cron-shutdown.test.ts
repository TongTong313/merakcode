import { expect, test, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { EngineHost } from "../../src/app/host"
import { Instance } from "../../src/infra/project/instance"
import { CronScheduler } from "../../src/app/task/cron"
import { Session } from "../../src/agent/session"
import { tmpdir } from "../fixture/fixture"

test("shutdown stops cron before draining memory and restart restores the persisted task", async () => {
  const memoryStarted = Promise.withResolvers<void>()
  const releaseMemory = Promise.withResolvers<void>()
  let holdMemory = true
  let requests = 0
  const model = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw) as { model: string; messages: unknown[] }
    if (body.model === "qwen-plus") requests++
    if (holdMemory && JSON.stringify(body.messages).includes("# Automatic memory extraction")) {
      memoryStarted.resolve()
      await releaseMemory.promise
    }
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(chunk({ content: "No memory updates." }, null) + chunk({}, "stop") + "data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve))
  try {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "alibaba-cn/qwen-plus",
        small_model: "alibaba-cn/qwen-flash",
        enabled_providers: ["alibaba-cn"],
        provider: {
          "alibaba-cn": {
            options: { apiKey: "fake", baseURL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1` },
          },
        },
        memory: { auto_extract: "always", auto_recall: false, session_memory: false, auto_dream: false },
        compaction: { auto: false },
        lsp: false,
      },
    })
    const network = { hostname: "127.0.0.1", port: 0, mdns: false, "mdns-domain": "merakcode.local" }
    let address: URL
    let taskID: string
    let sessionID: string
    let lastRun: number
    const inProject = <T>(fn: () => T) => Instance.provide({ directory: tmp.path, fn })
    const openProject = async () => {
      const response = await fetch(new URL(`/path?directory=${encodeURIComponent(tmp.path)}`, address))
      expect(response.status).toBe(200)
    }
    // Advance interval deadlines explicitly so a run cannot be admitted just before shutdown under load.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    await EngineHost.serve(network, {
      onListening: (url) => (address = url),
      waitForShutdown: async (cleanup) => {
        try {
          await openProject()
          await inProject(async () => {
            sessionID = (await Session.create({ title: "Cron shutdown regression" })).id
            taskID = await CronScheduler.create({
              sessionID,
              interval: 1_000,
              prompt: "cron shutdown regression",
            })
          })
          await memoryStarted.promise
          await expect.poll(() => inProject(() => CronScheduler.list(sessionID)[0]?.lastRun)).toBeTypeOf("number")
          lastRun = await inProject(() => CronScheduler.list(sessionID)[0].lastRun!)
          const beforeShutdown = requests
          const shuttingDown = cleanup()
          let duringShutdown: number
          try {
            // Keep a real memory request in flight past the next cron deadline while the host is draining.
            await inProject(() => vi.advanceTimersByTimeAsync(1_000))
            await new Promise((resolve) => setTimeout(resolve, 1_200))
            duringShutdown = requests
          } finally {
            holdMemory = false
            releaseMemory.resolve()
            await shuttingDown
          }
          expect(duringShutdown).toBe(beforeShutdown)
        } finally {
          holdMemory = false
          releaseMemory.resolve()
          await cleanup()
        }
      },
    })

    const beforeRestart = requests
    await EngineHost.serve(network, {
      onListening: (url) => (address = url),
      waitForShutdown: async (cleanup) => {
        try {
          await openProject()
          const restored = await inProject(() => CronScheduler.list(sessionID))
          expect(restored).toMatchObject([{ id: taskID, status: "running", lastRun }])
          await inProject(() => vi.advanceTimersByTimeAsync(1_000))
          await expect.poll(() => requests, { timeout: 10_000 }).toBeGreaterThan(beforeRestart)
          await expect
            .poll(() => inProject(() => CronScheduler.list(sessionID)[0]?.lastRun), { timeout: 10_000 })
            .toBeGreaterThan(lastRun)
        } finally {
          await cleanup()
        }
      },
    })
  } finally {
    releaseMemory.resolve()
    await Instance.disposeAll()
    vi.useRealTimers()
    model.closeAllConnections()
    await new Promise<void>((resolve) => model.close(() => resolve()))
  }
}, 30_000)

test("a pending project bootstrap does not extend the host caller's shutdown deadline", async () => {
  await using tmp = await tmpdir()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let bootstrap: Promise<unknown> | undefined
  let closing: Promise<unknown> | undefined
  const serving = EngineHost.serve(
    { hostname: "127.0.0.1", port: 0, mdns: false, "mdns-domain": "merakcode.local" },
    {
      waitForShutdown: async (cleanup) => {
        bootstrap = Instance.provide({
          directory: tmp.path,
          init: async () => {
            started.resolve()
            await release.promise
          },
          fn: () => undefined,
        })
        await started.promise
        closing = cleanup()
        // The caller owns the exit deadline and can return while best-effort draining is still pending.
        await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 50))])
      },
    },
  )
  try {
    await started.promise
    const outcome = await Promise.race([
      serving.then(() => "stopped"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
    ])
    expect(outcome).toBe("stopped")
  } finally {
    release.resolve()
    await bootstrap
    await closing
    await serving
    await Instance.disposeAll()
  }
}, 15_000)
