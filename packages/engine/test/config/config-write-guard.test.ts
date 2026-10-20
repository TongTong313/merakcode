import { describe, expect, test } from "vitest"
import path from "path"
import { ConfigWriteGuard } from "@merakcode/engine/config/config-write-guard"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { setTimeout as delay } from "node:timers/promises"

describe("ConfigWriteGuard", () => {
  test("snapshot and changed detect external writes", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "config.json")
    await Filesystem.write(file, "{}")

    const before = await ConfigWriteGuard.snapshot(file)
    expect(before.hash).toBeTruthy()

    await delay(10)
    await Filesystem.write(file, '{"a":1}')
    expect(await ConfigWriteGuard.changed(before, file)).toBe(true)
  })

  test("registerSelfWrite and consumeSelfWrite deduplicate self-writes", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "config.json")
    const content = '{"model":"x/y"}'
    ConfigWriteGuard.registerSelfWrite(file, content)
    expect(ConfigWriteGuard.consumeSelfWrite(file, content)).toBe(true)
    expect(ConfigWriteGuard.consumeSelfWrite(file, content)).toBe(false)
  })

  test("normalizePath normalizes drive letter case and separators", () => {
    expect(ConfigWriteGuard.normalizePath("C:\\foo\\bar.json")).toBe("c:/foo/bar.json")
  })
})
