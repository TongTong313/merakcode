import { describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { ConfigWriteGuard } from "@merakcode/engine/infra/config/write-guard"
import { ConfigWatch } from "@merakcode/engine/app/config/files/config-watch"
import { Global } from "@merakcode/engine/infra/global/index"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Config } from "@merakcode/engine/app/config/files/config"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { setTimeout as delay } from "node:timers/promises"

describe("ConfigWatch", () => {
  test("skips self-writes and broadcasts only external changes", async () => {
    await using tmp = await tmpdir()
    const configDir = path.join(tmp.path, "config")
    await fs.mkdir(configDir, { recursive: true })
    const file = path.join(configDir, "merakcode.json")
    await Filesystem.write(file, '{"model":"a/b"}')

    const prev = Global.Path.config
    ;(Global.Path as { config: string }).config = configDir

    try {
      // Self-write: registered and queued, so flush skips it
      ConfigWriteGuard.registerSelfWrite(file, '{"model":"a/b"}')
      ConfigWatch.__testingQueueGlobal(file)
      expect(await ConfigWatch.__testingFlushGlobal()).toBe(false)

      // External change: content matches no registered self-write, so flush broadcasts
      await Filesystem.write(file, '{"model":"c/d"}')
      ConfigWatch.__testingQueueGlobal(file)
      expect(await ConfigWatch.__testingFlushGlobal()).toBe(true)
    } finally {
      ;(Global.Path as { config: string }).config = prev
      await ConfigWatch.disposeGlobal()
    }
  })

  test("returns false for an empty queue", async () => {
    expect(await ConfigWatch.__testingFlushGlobal()).toBe(false)
  })

  test("picks up project config edited outside the engine", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Filesystem.write(path.join(dir, ".merakcode", "merakcode.json"), JSON.stringify({ model: "a/b" })),
    })
    const file = path.join(tmp.path, ".merakcode", "merakcode.json")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await Config.get()).model).toBe("a/b")
        ConfigWatch.initInstance()
        // The subscription is set up asynchronously: keep writing until the watcher sees it instead of a fixed wait
        for (let attempt = 0; attempt < 40 && (await Config.get()).model !== "c/d"; attempt++) {
          await Filesystem.write(file, JSON.stringify({ model: "c/d" }))
          await delay(250)
        }
        expect((await Config.get()).model).toBe("c/d")
      },
    })
  }, 30_000)
})
