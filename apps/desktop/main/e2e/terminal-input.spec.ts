import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

test("Unicode commands typed during terminal startup stay out of the conversation and run intact", async ({ kit }) => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await kit.page.route("**/pty", async (route) => {
    if (route.request().method() === "POST") {
      entered.resolve()
      await release.promise
    }
    await route.continue()
  })
  const marker = path.join(kit.project, "early-input.txt")
  const script = path.join(kit.project, "启动任务.mjs")
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "complete")`,
  )
  try {
    await kit.openPanel("terminal", true)
    await entered.promise
    await kit.page.getByRole("region", { name: "终端", exact: true }).click()
    await kit.page.keyboard.type(`node "${script}"`)
    await expect(kit.page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("")
    await kit.page.keyboard.press("Enter")
    release.resolve()
    await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe("complete")
    await expect(kit.page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("")
  } finally {
    release.resolve()
  }
})

for (const cancel of [false, true])
  test(
    cancel
      ? "terminal readiness preserves input after a native composition is cancelled"
      : "terminal readiness preserves an unfinished native input composition",
    async ({ kit }) => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      await kit.page.route("**/pty", async (route) => {
        if (route.request().method() === "POST") {
          entered.resolve()
          await release.promise
        }
        await route.continue()
      })
      const marker = path.join(kit.project, "composed-input.txt")
      const script = path.join(kit.project, "启动任务.mjs")
      await writeFile(
        script,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "complete")`,
      )
      const cdp = await kit.page.context().newCDPSession(kit.page)
      try {
        await kit.openPanel("terminal", true)
        await entered.promise
        await kit.page.getByRole("region", { name: "终端", exact: true }).click()
        await kit.page.keyboard.type(`node "${kit.project}${path.sep}`)
        await cdp.send("Input.imeSetComposition", { text: "启", selectionStart: 1, selectionEnd: 1 })
        const created = kit.page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/pty" && response.request().method() === "POST",
        )
        release.resolve()
        await created
        await kit.page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        )
        if (cancel) await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 })
        await cdp.send("Input.insertText", { text: "启动任务" })
        await kit.page.keyboard.type('.mjs"')
        await kit.page.keyboard.press("Enter")
        await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe("complete")
        await expect(kit.page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("")
      } finally {
        release.resolve()
        await cdp.detach()
      }
    },
  )

test("terminal startup does not take focus from a conversation the user is editing", async ({ kit }) => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await kit.page.route("**/pty", async (route) => {
    if (route.request().method() === "POST") {
      entered.resolve()
      await release.promise
    }
    await route.continue()
  })
  try {
    await kit.openPanel("terminal", true)
    await entered.promise
    const composer = kit.page.getByRole("textbox", { name: "消息", exact: true })
    await composer.fill("keep editing")
    release.resolve()
    await kit.page.getByRole("textbox", { name: "Terminal input", exact: true }).last().waitFor()
    await expect(composer).toBeFocused()
    await kit.page.keyboard.type(" here")
    await expect(composer).toHaveValue("keep editing here")
  } finally {
    release.resolve()
  }
})
