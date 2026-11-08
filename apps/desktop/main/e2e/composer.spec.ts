import { test, expect } from "./fixture"

test.use({
  script: { reply: ({ prompt }) => ({ text: prompt.includes("第一行\n第二行") ? "MULTILINE_OK" : "INPUT_OK" }) },
})

test("Shift Enter inserts a newline and Enter sends the message once", async ({ kit }) => {
  const input = kit.page.getByRole("textbox", { name: "消息", exact: true })
  await input.fill("第一行")
  await input.press("End")
  await input.press("Shift+Enter")
  await input.pressSequentially("第二行")
  await expect(input).toHaveValue("第一行\n第二行")
  expect(kit.requests()).toBe(0)
  await input.press("Enter")
  await expect(kit.text("MULTILINE_OK")).toBeVisible()
  await expect(input).toHaveValue("")
  expect(kit.requests()).toBe(1)
})

test.describe("cancellation", () => {
  test.use({
    script: {
      reply: async ({ closed }) => {
        await closed
        return { text: "UNREACHABLE" }
      },
    },
  })
  test("stops an in-flight model request and enables the composer", async ({ kit }) => {
    await kit.send("等待")
    await expect.poll(kit.requests).toBe(1)
    await kit.page.getByRole("button", { name: /^(停止|Stop)$/ }).click()
    await expect(kit.page.getByRole("button", { name: /^(停止|Stop)$/ })).toHaveCount(0)
    await expect(kit.page.getByRole("textbox", { name: "消息", exact: true })).toBeEnabled()
    await expect(kit.text("UNREACHABLE")).toHaveCount(0)
  })
})
