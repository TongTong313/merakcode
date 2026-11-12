import { test, expect } from "./fixture"

/** Whether the idle extractor has started its model request */
let writingMemory = false

test.use({
  // Idle extraction is off by default; this case needs it on.
  config: { memory: { auto_extract: true } },
  script: {
    reply: async ({ system, closed }) => {
      if (!system.includes("Extract durable project facts")) return { text: "回复完了" }
      writingMemory = true
      await closed
      return { text: "[]" }
    },
  },
})

test("once the reply is done the conversation stops reading as running, even while memory is still being written", async ({
  kit,
}) => {
  await kit.send("你好")
  await expect(kit.text("回复完了")).toBeVisible()
  await expect.poll(() => writingMemory, { timeout: 45_000 }).toBe(true)
  const row = kit.page.getByRole("navigation", { name: "对话" }).getByRole("link").first()
  await expect(row).toContainText("你好")
  await expect(row).not.toContainText("运行中")
})
