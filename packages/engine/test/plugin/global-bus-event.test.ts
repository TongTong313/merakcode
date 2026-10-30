import os from "node:os"
import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from "url"
import { Plugin } from "@merakcode/engine/agent/plugin/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { GlobalBus } from "@merakcode/engine/infra/bus/global"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * GlobalBus events are forwarded to the plugin `event` hook.
 *
 * `GlobalBus` is a process-wide EventEmitter for cross-Instance broadcasts such as OIDC login state, separate from the
 * per-Instance `Bus` that feeds the `event` hook through `Bus.subscribeAll`. Plugins such as the login status reflow
 * depend on GlobalBus events.
 *
 * Unlike `Bus`, `GlobalBus` listeners are not dropped when `Instance.state()` is rebuilt, so these tests also check
 * that listeners are registered once and removed on dispose, keeping them from growing across Instances.
 */

async function setup(dir: string) {
  const root = path.join(dir, ".merakcode")
  const plugins = path.join(root, "plugin")
  const modules = path.join(root, "node_modules")
  await fs.mkdir(plugins, { recursive: true })
  await fs.mkdir(modules, { recursive: true })
  await fs.symlink(
    path.dirname(fileURLToPath(import.meta.resolve("zod"))),
    path.join(modules, "zod"),
    process.platform === "win32" ? "junction" : "dir",
  )
  return plugins
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("GlobalBus events reach the event hook", () => {
  test("the plugin event hook receives events from GlobalBus.emit, not only from Bus", async () => {
    const captureFile = path.join(os.tmpdir(), `global-bus-capture-${Date.now()}-${Math.random()}.json`)
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugins = await setup(dir)
        await Filesystem.write(
          path.join(plugins, "global-bus-probe.ts"),
          [
            "import fs from 'fs/promises'",
            "export default {",
            '  id: "global-bus-probe",',
            "  server: async () => ({",
            "    event: async ({ event }) => {",
            `      if (event.type !== "h14-test.global-event") return`,
            `      await fs.appendFile(${JSON.stringify(captureFile)}, JSON.stringify(event) + "\\n")`,
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Plugin.init()
          GlobalBus.emit("event", {
            directory: "global",
            payload: { type: "h14-test.global-event", properties: { foo: "bar" } },
          })
          // The event hook is fire-and-forget; give it time to write the file
          await new Promise((resolve) => setTimeout(resolve, 50))
        },
      })

      const captured = await fs.readFile(captureFile, "utf-8").catch(() => "")
      expect(
        captured
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([{ type: "h14-test.global-event", properties: { foo: "bar" } }])
    } finally {
      await fs.rm(captureFile, { force: true })
    }
  })

  test("calling Plugin.init() repeatedly in one Instance registers the GlobalBus listener once", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugins = await setup(dir)
        await Filesystem.write(
          path.join(plugins, "noop.ts"),
          'export default { id: "noop", server: async () => ({}) }\n',
        )
      },
    })

    const before = GlobalBus.listenerCount("event")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.init()
        await Plugin.init()
        await Plugin.init()
      },
    })
    expect(GlobalBus.listenerCount("event")).toBe(before + 1)
  })

  test("disposing the Instance removes its GlobalBus listener", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugins = await setup(dir)
        await Filesystem.write(
          path.join(plugins, "noop.ts"),
          'export default { id: "noop", server: async () => ({}) }\n',
        )
      },
    })

    const before = GlobalBus.listenerCount("event")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.init()
        expect(GlobalBus.listenerCount("event")).toBe(before + 1)
      },
    })
    await Instance.disposeAll()
    expect(GlobalBus.listenerCount("event")).toBe(before)
  })

  test("plugins receive GlobalBus events emitted outside any Instance context without hanging", async () => {
    // Regression: state() resolves the current Instance through AsyncLocalStorage, but GlobalBus.emit often fires from
    // paths outside Instance.provide(), such as the OIDC token refresh timer. state() used to throw there, and since
    // EventEmitter neither awaits nor catches, the rejection went unhandled and hung the whole worker.
    const captureFile = path.join(os.tmpdir(), `global-bus-no-context-${Date.now()}-${Math.random()}.json`)
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugins = await setup(dir)
        await Filesystem.write(
          path.join(plugins, "no-context-probe.ts"),
          [
            "import fs from 'fs/promises'",
            "export default {",
            '  id: "no-context-probe",',
            "  server: async () => ({",
            "    event: async ({ event }) => {",
            `      if (event.type !== "h14-test.no-context") return`,
            `      await fs.appendFile(${JSON.stringify(captureFile)}, "hit\\n")`,
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Plugin.init()
        },
      })

      // Emitted outside Instance.provide(), with no ambient Instance context
      GlobalBus.emit("event", { directory: "global", payload: { type: "h14-test.no-context", properties: {} } })
      await new Promise((resolve) => setTimeout(resolve, 100))

      const captured = await fs.readFile(captureFile, "utf-8").catch(() => "")
      expect(captured.trim()).toBe("hit")
    } finally {
      await fs.rm(captureFile, { force: true })
    }
  })

  test("an Instance that never calls Plugin.init() registers no GlobalBus listener", async () => {
    const before = GlobalBus.listenerCount("event")
    await using tmp = await tmpdir({})
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Plugin.init() is intentionally not called
      },
    })
    expect(GlobalBus.listenerCount("event")).toBe(before)
  })
})
