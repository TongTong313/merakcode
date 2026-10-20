import { test, expect } from "./fixture"

// Composer: @ references a file (its content goes to the model), / runs commands (project commands, compaction)

test.use({
  config: { command: { hello: { description: "打个招呼", template: "说 E2E_CMD $ARGUMENTS" } } },
  script: {
    reply: ({ prompt }) => {
      if (prompt.includes("E2E_CMD")) return { text: `命令展开成：${prompt.match(/说 E2E_CMD .*/)?.[0] ?? ""}` }
      if (prompt.includes("hello from e2e")) return { text: "看到了文件内容" }
      return { text: `收到：${prompt.slice(0, 40)}` }
    },
  },
})

test("@ file reference: picked from the list, its content reaches the model", async ({ kit }) => {
  const input = kit.page.getByRole("textbox", { name: "消息" })
  await input.click()
  await input.pressSequentially("看看 @note", { delay: 10 })
  const list = kit.page.getByRole("listbox", { name: "引用文件" })
  await expect(list.getByRole("option", { name: "notes.txt" })).toBeVisible()
  await kit.page.keyboard.press("Enter")
  await expect(input).toHaveValue("看看 @notes.txt ")
  await kit.page.keyboard.press("Enter")
  await expect(kit.text("看到了文件内容")).toBeVisible({ timeout: 60_000 })
})

test("/ commands: runs a project command with arguments; /compact compacts the context", async ({ kit }) => {
  const input = kit.page.getByRole("textbox", { name: "消息" })
  await input.click()
  await input.pressSequentially("/hel", { delay: 10 })
  const list = kit.page.getByRole("listbox", { name: "命令" })
  await expect(list.getByRole("option", { name: /hello/ })).toBeVisible()
  await kit.page.keyboard.press("Enter")
  await expect(input).toHaveValue("/hello ")
  await input.pressSequentially("世界", { delay: 10 })
  await kit.page.keyboard.press("Enter")
  await expect(kit.text("命令展开成：说 E2E_CMD 世界")).toBeVisible({ timeout: 60_000 })

  await input.click()
  await input.pressSequentially("/compact", { delay: 10 })
  await expect(list.getByRole("option", { name: /compact/ })).toBeVisible()
  await kit.page.keyboard.press("Enter")
  await kit.page.keyboard.press("Enter")
  await expect(kit.text("上下文已压缩")).toBeVisible({ timeout: 60_000 })
})
