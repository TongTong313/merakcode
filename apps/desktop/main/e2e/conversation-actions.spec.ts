import { access, readFile } from "node:fs/promises"
import path from "node:path"
import { test, expect, type Kit } from "./fixture"

// Basic conversation actions: revert to a message (files revert too, and can be restored), edit and resend, retry,
// copy a reply, rename, context usage

/** The "write file" turn writes a file; every other turn replies with a numbered answer */
let count = 0
let current: Kit
test.use({
  script: {
    reply: ({ prompt, toolResults }) => {
      if (prompt.includes("写文件"))
        return toolResults.length
          ? { text: "写好了" }
          : { tool: "write", args: { filePath: path.join(current.project, "made.txt"), content: "made\n" } }
      count += 1
      return { text: `第${count}次回答：${prompt}` }
    },
  },
})

test.beforeEach(({ kit }) => {
  current = kit
  count = 0
})

const user = (kit: Kit, text: string) =>
  kit.page
    .getByRole("log")
    .getByRole("article", { name: /^(你说|You)/ })
    .filter({ hasText: text })

test("reverting to a message hides it and later ones and reverts files; restore brings all back", async ({ kit }) => {
  await kit.send("先打个招呼")
  await expect(kit.text("第1次回答：先打个招呼")).toBeVisible({ timeout: 60_000 })
  await kit.send("写文件")
  await expect(kit.text("写好了")).toBeVisible({ timeout: 60_000 })
  expect(await readFile(path.join(kit.project, "made.txt"), "utf8")).toBe("made\n")

  const message = user(kit, "写文件")
  await message.hover()
  await message.getByRole("button", { name: "退回到这里" }).click()
  await expect(kit.text("写好了")).toHaveCount(0)
  await expect(user(kit, "写文件")).toHaveCount(0)
  await expect(access(path.join(kit.project, "made.txt"))).rejects.toThrow()
  await expect(kit.text("第1次回答：先打个招呼")).toBeVisible()

  await kit.page.getByRole("button", { name: "恢复" }).click()
  await expect(kit.text("写好了")).toBeVisible()
  await expect.poll(() => readFile(path.join(kit.project, "made.txt"), "utf8").catch(() => "")).toBe("made\n")
})

test("edit and resend replaces the original turn; retry answers the last turn again", async ({ kit }) => {
  await kit.send("你好")
  await expect(kit.text("第1次回答：你好")).toBeVisible({ timeout: 60_000 })

  const message = user(kit, "你好")
  await message.hover()
  await message.getByRole("button", { name: "编辑" }).click()
  const input = kit.page.getByRole("textbox", { name: "消息" })
  await expect(input).toHaveValue("你好")
  await expect(kit.text("第1次回答：你好")).toHaveCount(0)
  await input.fill("你好呀")
  await kit.page.keyboard.press("Enter")
  await expect(kit.text("第2次回答：你好呀")).toBeVisible({ timeout: 60_000 })
  await expect(user(kit, "你好呀")).toHaveCount(1)

  await kit.page.getByRole("log").getByRole("button", { name: "重试" }).last().click()
  await expect(kit.text("第3次回答：你好呀")).toBeVisible({ timeout: 60_000 })
  await expect(kit.text("第2次回答：你好呀")).toHaveCount(0)
})

test("copies a reply, renames the conversation and shows context usage next to the input", async ({ kit }) => {
  await kit.send("你好")
  await expect(kit.text("第1次回答：你好")).toBeVisible({ timeout: 60_000 })

  await kit.page.getByRole("log").getByRole("button", { name: "复制" }).last().click()
  await expect.poll(() => kit.app.evaluate(({ clipboard }) => clipboard.readText())).toBe("第1次回答：你好")

  // The fake model reports 13,100 tokens per request, so context usage is a percentage above 0
  await expect(kit.page.getByRole("status", { name: /^上下文已用 \d+%$/ })).toBeVisible()

  const sidebar = kit.page.getByRole("navigation", { name: "对话" })
  await sidebar.getByRole("link").first().hover()
  await sidebar.getByRole("button", { name: "对话操作" }).first().click()
  await kit.page.getByRole("menuitem", { name: "重命名" }).click()
  const dialog = kit.page.getByRole("dialog", { name: "重命名对话" })
  await dialog.getByRole("textbox").fill("新名字")
  await dialog.getByRole("button", { name: "保存" }).click()
  await expect(sidebar.getByRole("link", { name: /新名字/ })).toBeVisible()
})
