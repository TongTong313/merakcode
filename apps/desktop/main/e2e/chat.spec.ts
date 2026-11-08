import { test, expect } from "./fixture"

test.use({ script: { reply: ({ prompt }) => ({ text: prompt.includes("你好") ? "CHAT_OK" : "SECOND_OK" }) } })

test("streams a reply and retains history after reloading the window", async ({ kit }) => {
  await kit.send("你好")
  await expect(kit.text("CHAT_OK")).toBeVisible()
  await kit.page.reload()
  await expect(kit.text("CHAT_OK")).toBeVisible()
  await kit.send("下一条")
  await expect(kit.text("SECOND_OK")).toBeVisible()
  await expect(kit.text("CHAT_OK")).toBeVisible()
})

test.describe("math", () => {
  test.use({ script: { reply: () => ({ text: "质能方程：$$E = mc^2$$" }) } })
  test("renders LaTeX as math", async ({ kit }) => {
    await kit.send("公式")
    await expect(kit.page.getByRole("math").filter({ visible: true }).last()).toBeVisible()
  })
})
