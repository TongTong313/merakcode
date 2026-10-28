import { expect, test } from "./fixture"

test.use({ git: true, script: { reply: ({ prompt }) => ({ text: `Reply: ${prompt}` }) } })

test("the composer stays usable beside Git management when the window shrinks and reloads", async ({ kit }) => {
  const { page } = kit
  await kit.send("Open this conversation")
  await expect(kit.text("Reply: Open this conversation")).toBeVisible()
  await page.getByRole("button", { name: "右侧面板" }).click()
  await kit.panel().getByRole("tab", { name: "Git 管理" }).click()
  const input = page.getByRole("textbox", { name: "消息", exact: true })
  for (const [index, width] of [1440, 1024, 800, 1280, 1024].entries()) {
    await kit.app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 720),
      width,
    )
    if (index === 4) await page.reload()
    await expect(input).toBeVisible()
    await expect
      .poll(async () => {
        const box = await input.boundingBox()
        const panel = await kit.panel().boundingBox()
        return Boolean(box && panel && box.width > 0 && box.x + box.width <= panel.x + 1)
      })
      .toBe(true)
    const prompt = `Message at ${width}, turn ${index}`
    await kit.send(prompt)
    await expect(kit.text(`Reply: ${prompt}`)).toBeVisible()
  }
})
