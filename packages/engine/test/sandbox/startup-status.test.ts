import { expect, test } from "vitest"
import { PermissionExecution } from "../../src/agent/permission/execution"
import { Instance } from "../../src/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { GlobalBus } from "../../src/infra/bus/global"

test("disabled test isolation never probes or changes the real sandbox account", async () => {
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "off"
  const called: string[] = []
  PermissionExecution.useBackendForTest({
    status: async () => {
      called.push("status")
      return { status: "unsupported", installable: true }
    },
    setup: async () => {
      called.push("setup")
      return { status: "on" }
    },
    reset: async () => {
      called.push("reset")
      return { status: "unsupported", installable: true }
    },
    wrap: async () => {
      throw new Error("No command expected")
    },
  })
  try {
    for (const status of [
      await PermissionExecution.current(),
      await PermissionExecution.install(),
      await PermissionExecution.reset(),
    ])
      expect(status.status).toBe("off")
    expect(called).toEqual([])
  } finally {
    PermissionExecution.useBackendForTest(undefined)
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
  }
})

test.each(["zh-CN", "en-US"])("backend startup failures include a localized repair hint in %s", async (locale) => {
  const previousLocale = process.env.MERAKCODE_LOCALE
  const previousMode = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_LOCALE = locale
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  PermissionExecution.useBackendForTest({
    status: async () => ({ status: "failed", reason: "Account launch failed" }),
    wrap: async () => {
      throw new Error("No command expected")
    },
  })
  try {
    expect(await PermissionExecution.current()).toMatchObject({
      status: "failed",
      errorCode: "MRK-5003",
      reason: locale === "zh-CN" ? expect.stringContaining("请重试初始化") : expect.stringContaining("Retry setup"),
    })
    expect(await PermissionExecution.ready()).toBe(false)
  } finally {
    PermissionExecution.useBackendForTest(undefined)
    if (previousLocale === undefined) delete process.env.MERAKCODE_LOCALE
    else process.env.MERAKCODE_LOCALE = previousLocale
    if (previousMode === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previousMode
  }
})

test("sandbox initialization broadcasts its real state to every window", async () => {
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  let ready = false
  PermissionExecution.useBackendForTest({
    status: async () => (ready ? { status: "on", backend: "landlock" } : { status: "unsupported", installable: true }),
    setup: async () => {
      ready = true
      return { status: "on", backend: "landlock" }
    },
    wrap: async () => {
      throw new Error("No command expected")
    },
  })
  const first: unknown[] = []
  const second: unknown[] = []
  const a = (event: { directory?: string; payload: { type: string; properties: unknown } }) => {
    if (event.payload.type === "sandbox.updated") first.push(event)
  }
  const b = (event: { directory?: string; payload: { type: string; properties: unknown } }) => {
    if (event.payload.type === "sandbox.updated") second.push(event)
  }
  GlobalBus.on("event", a)
  GlobalBus.on("event", b)
  try {
    await PermissionExecution.install()
    expect(first).toEqual(
      expect.arrayContaining([
        {
          directory: "global",
          payload: { type: "sandbox.updated", properties: expect.objectContaining({ status: "on" }) },
        },
      ]),
    )
    expect(second).toEqual(first)
  } finally {
    GlobalBus.off("event", a)
    GlobalBus.off("event", b)
    PermissionExecution.useBackendForTest(undefined)
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
  }
})

test("legacy config off does not disable an installed sandbox", async () => {
  await using tmp = await tmpdir({ git: true, config: { sandbox: { mode: "off" } } })
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  delete process.env.MERAKCODE_SANDBOX_MODE
  let warmed = 0
  PermissionExecution.useBackendForTest({
    status: async () => ({ status: "on", backend: "landlock" }),
    warm: async () => {
      warmed++
    },
    wrap: async () => {
      throw new Error("No command expected")
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await PermissionExecution.wake()).status).toBe("on")
        expect(warmed).toBe(1)
      },
    })
  } finally {
    PermissionExecution.useBackendForTest(undefined)
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
  }
})

test("a failed sandbox wake remains visibly failed until a shared retry succeeds", async () => {
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  let failing = true
  let warmed = 0
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  PermissionExecution.useBackendForTest({
    status: async () => ({ status: "on", backend: "landlock" }),
    warm: async () => {
      warmed++
      if (failing) throw new Error("Controlled wake failure")
      entered.resolve()
      await release.promise
    },
    wrap: async () => {
      throw new Error("No command expected")
    },
  })
  try {
    expect(await PermissionExecution.wake()).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("Controlled wake failure"),
    })
    expect((await PermissionExecution.current()).status).toBe("failed")
    expect(await PermissionExecution.ready()).toBe(false)
    failing = false
    const first = PermissionExecution.wake()
    const second = PermissionExecution.wake()
    await entered.promise
    expect((await PermissionExecution.current()).status).toBe("starting")
    expect(warmed).toBe(2)
    release.resolve()
    expect((await first).status).toBe("on")
    expect((await second).status).toBe("on")
  } finally {
    release.resolve()
    PermissionExecution.useBackendForTest(undefined)
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
  }
})
