import { test, expect } from "./fixture"

/** Whether session memory has asked the model to update its notes */
let writingMemory = false

// The fake model reports 13k prompt tokens, past the threshold where session memory starts after a reply
test.use({
  config: { memory: { session_memory: true, auto_extract: false, auto_recall: false, auto_dream: false } },
  script: {
    reply: ({ prompt }) => {
      if (!prompt.includes("update the session notes file")) return { text: "回复完了" }
      writingMemory = true
      // It keeps working in the background until the app closes
      return new Promise(() => {})
    },
  },
})

test("once the reply is done the conversation stops reading as running, even while memory is still being written", async ({
  kit,
}) => {
  await kit.send("你好")
  await expect(kit.text("回复完了")).toBeVisible()
  await expect.poll(() => writingMemory).toBe(true)
  const row = kit.page.getByRole("navigation", { name: "对话" }).getByRole("link").first()
  await expect(row).toContainText("E2E")
  await expect(row).not.toContainText("运行中")
})
