import { expect, test } from "vitest"
import { Text } from "@merakcode/engine/util/text"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"

// Engine text sent to the UI is Chinese or English depending on the configured locale; Chinese by default

test("picks the language from config, Chinese by default", async () => {
  await using zh = await tmpdir()
  await Instance.provide({
    directory: zh.path,
    fn: async () => {
      expect(await Text.lang()).toBe("zh")
      expect(await Text.pick({ zh: "已创建", en: "Created" })).toBe("已创建")
    },
  })
  await using en = await tmpdir({ config: { locale: "en-US" } })
  await Instance.provide({
    directory: en.path,
    fn: async () => {
      expect(await Text.lang()).toBe("en")
      expect(await Text.pick({ zh: "已创建", en: "Created" })).toBe("Created")
    },
  })
})

test("format replaces {name} parameters and keeps placeholders for missing ones", () => {
  expect(Text.format({ zh: "已写入 {path}", en: "Wrote {path}" }, "en", { path: "a.txt" })).toBe("Wrote a.txt")
  expect(Text.format({ zh: "已写入 {path}", en: "Wrote {path}" }, "zh")).toBe("已写入 {path}")
})

test("MERAKCODE_LOCALE takes precedence over config", async () => {
  await using zh = await tmpdir()
  const before = process.env.MERAKCODE_LOCALE
  process.env.MERAKCODE_LOCALE = "en_US.UTF-8"
  try {
    await Instance.provide({ directory: zh.path, fn: async () => expect(await Text.lang()).toBe("en") })
    expect(await Text.lang()).toBe("en")
  } finally {
    if (before === undefined) delete process.env.MERAKCODE_LOCALE
    else process.env.MERAKCODE_LOCALE = before
  }
})

test("outside a project uses the global config, falling back to Chinese", async () => {
  expect(await Text.lang()).toBe("zh")
})
