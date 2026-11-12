import { readFile, writeFile, mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { test, expect } from "./fixture"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"
import { connect } from "@merakcode/sdk"

test("archiving continues terminal cleanup when an earlier browser tab refuses to close", async ({ kit }) => {
  await kit.send("archive resources")
  await expect(kit.text("OK")).toBeVisible()
  const sessionID = new URL(kit.page.url()).pathname.split("/").at(-1)!
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html")
    response.end(
      "<title>Archive page</title><input><script>onbeforeunload=e=>{e.preventDefault();e.returnValue=true}</script>",
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    await kit.openPanel("browser", true)
    const address = kit.panel().getByRole("textbox", { name: "地址" })
    await address.fill(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    await address.press("Enter")
    await expect(kit.panel().getByRole("tab", { name: "Archive page", exact: true })).toBeVisible()
    await kit.app.evaluate(async ({ dialog, webContents }) => {
      const page = webContents.getAllWebContents().find((value) => value.getTitle() === "Archive page")!
      await page.executeJavaScript('document.querySelector("input").focus()', true)
      page.sendInputEvent({ type: "mouseDown", x: 12, y: 12, button: "left", clickCount: 1 })
      page.sendInputEvent({ type: "mouseUp", x: 12, y: 12, button: "left", clickCount: 1 })
      delete process.env.MERAKCODE_BROWSER_LEAVE_UNLOAD
      dialog.showMessageBoxSync = () => 0
    })
    const marker = path.join(kit.project, "archived-pid.txt")
    const script = path.join(kit.project, "archived-task.mjs")
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 100)`,
    )
    await kit.openPanel("terminal", true)
    await kit.page.locator(".terminal-host:visible").click()
    await kit.page.keyboard.type(`node "${script}"`)
    await kit.page.keyboard.press("Enter")
    await expect.poll(() => readFile(marker, "utf8").catch(() => "")).not.toBe("")
    const pid = Number(await readFile(marker, "utf8"))
    const client = await connect(JSON.parse(await readFile(path.join(kit.root, "data", "engine.json"), "utf8")))
    try {
      await client.session.update({ session: sessionID, archived: true })
    } finally {
      await client.close()
    }
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      })
      .toBe(false)
    await expect(kit.page.locator(".toast").getByRole("button", { name: "重试", exact: true })).toBeVisible()
  } finally {
    await kit.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 1
    })
    server.closeAllConnections()
    server.close()
  }
})

for (const rejectWrite of [false, true]) {
  test(
    rejectWrite
      ? "final draft failure in one window preserves terminal tasks in every window"
      : "cancelling application quit in another window keeps the first window terminal alive",
    async ({ kit }) => {
      const marker = path.join(kit.project, "quit-pid.txt")
      const script = path.join(kit.project, "quit-task.mjs")
      await writeFile(
        script,
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 100)`,
      )
      await kit.openPanel("terminal", true)
      await kit.page.locator(".terminal-host textarea").focus()
      await kit.page.keyboard.type(`node "${script}"`)
      await kit.page.keyboard.press("Enter")
      await expect.poll(() => readFile(marker, "utf8").catch(() => "")).not.toBe("")
      const pid = Number(await readFile(marker, "utf8"))
      const other = path.join(kit.root, "other-project")
      await mkdir(other)
      await writeFile(path.join(other, "notes.txt"), "other window\n")
      const opened = kit.app.waitForEvent("window")
      await kit.page.evaluate(
        (directory) =>
          (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__.openWindow({
            directory,
          }),
        other,
      )
      const page = await opened
      let otherPID: number | undefined
      if (rejectWrite) {
        const otherMarker = path.join(other, "other-pid.txt")
        const otherScript = path.join(other, "other-task.mjs")
        await writeFile(
          otherScript,
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(otherMarker)}, String(process.pid)); setInterval(() => {}, 100)`,
        )
        await page.getByRole("button", { name: "右侧面板", exact: true }).click()
        await page.getByRole("button", { name: "新标签页", exact: true }).click()
        await page.locator('[data-panel-kind="terminal"]').click()
        await page.locator(".terminal-host textarea").focus()
        await page.keyboard.type(`node "${otherScript}"`)
        await page.keyboard.press("Enter")
        await expect.poll(() => readFile(otherMarker, "utf8").catch(() => "")).not.toBe("")
        otherPID = Number(await readFile(otherMarker, "utf8"))
        await page.evaluate(() => {
          const bridge = (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__
          bridge.onCloseCancelled(() => Object.assign(window, { quitCancelled: true }))
        })
      } else await page.getByRole("button", { name: "右侧面板", exact: true }).click()
      await page.getByRole("button", { name: "新标签页", exact: true }).click()
      await page.locator('[data-panel-kind="file"]').click()
      await page.getByRole("treeitem", { name: "notes.txt", exact: true }).click()
      const editor = page.getByRole("code").first()
      await expect(editor).toContainText("other window")
      await editor.click()
      await page.keyboard.type("unsaved")
      await expect(page.getByRole("tab", { name: /^notes\.txt/ })).toContainText("●")
      const otherURL = page.url()
      try {
        await kit.app.evaluate(({ app }) => app.quit())
        if (rejectWrite) {
          await expect(page.getByRole("dialog")).toBeVisible()
          await kit.openPanel("file")
          await kit.panel().getByRole("treeitem", { name: "notes.txt", exact: true }).click()
          const late = kit.panel().getByRole("code").first()
          await expect(late).toContainText("hello from e2e")
          const prefixes = [...new Set([kit.project, await realpath(kit.project)])].map(
            (value) => `draft-${Buffer.from(value).toString("base64url")}`,
          )
          await kit.app.evaluate((_, prefixes) => {
            const fs = process.getBuiltinModule("fs")
            const { syncBuiltinESMExports } = process.getBuiltinModule("module")
            const original = fs.writeFileSync
            fs.writeFileSync = (...args: Parameters<typeof original>) => {
              if (prefixes.some((prefix) => String(args[0]).includes(prefix)))
                throw new Error("Simulated draft write failure")
              return original(...args)
            }
            syncBuiltinESMExports()
            Object.assign(globalThis, {
              restoreRejectedDraftWrites: () => {
                fs.writeFileSync = original
                syncBuiltinESMExports()
              },
            })
          }, prefixes)
          await late.click()
          await kit.page.keyboard.type("late edits after initial agreement")
          await expect(kit.panel().getByRole("tab", { name: /^notes\.txt/ })).toContainText("●")
          await page.getByRole("dialog").getByRole("button", { name: "保留草稿并关闭", exact: true }).click()
          await expect(kit.page.getByRole("dialog")).toContainText("MRK-4025")
          await expect.poll(() => page.evaluate(() => Reflect.get(window, "quitCancelled"))).toBe(true)
          expect(() => process.kill(otherPID!, 0)).not.toThrow()
        } else await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click()
        expect(() => process.kill(pid, 0)).not.toThrow()
      } finally {
        if (rejectWrite) {
          await kit.app
            .evaluate(() => {
              const restore = Reflect.get(globalThis, "restoreRejectedDraftWrites")
              if (typeof restore === "function") restore()
            })
            .catch(() => {})
          await kit.page
            .getByRole("dialog")
            .getByRole("button", { name: "取消", exact: true })
            .click()
            .catch(() => {})
        }
        await kit.app
          .evaluate(({ BrowserWindow }, url) => {
            for (const win of BrowserWindow.getAllWindows()) if (win.webContents.getURL() === url) win.destroy()
          }, otherURL)
          .catch(() => {})
      }
    },
  )
}

test("staying on a browser page during window close keeps terminal tasks running", async ({ kit }) => {
  const marker = path.join(kit.project, "close-pid.txt")
  const script = path.join(kit.project, "close-task.mjs")
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 100)`,
  )
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html")
    response.end(
      "<title>Keep page</title><input><script>window.onbeforeunload = (e) => {e.preventDefault(); e.returnValue = true}</script>",
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    await kit.openPanel("terminal", true)
    await kit.page.locator(".terminal-host:visible").click()
    await kit.page.keyboard.type(`node "${script}"`)
    await kit.page.keyboard.press("Enter")
    await expect.poll(() => readFile(marker, "utf8").catch(() => "")).not.toBe("")
    const pid = Number(await readFile(marker, "utf8"))
    await kit.openPanel("browser", true)
    const address = kit.panel().getByRole("textbox", { name: "地址" })
    await address.fill(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    await address.press("Enter")
    await expect(kit.panel().getByRole("tab", { name: "Keep page" })).toBeVisible()
    await kit.app.evaluate(async ({ dialog, webContents, BrowserWindow }) => {
      const page = webContents.getAllWebContents().find((value) => value.getTitle() === "Keep page")!
      await page.executeJavaScript('document.querySelector("input").focus()', true)
      page.sendInputEvent({ type: "mouseDown", x: 12, y: 12, button: "left", clickCount: 1 })
      page.sendInputEvent({ type: "mouseUp", x: 12, y: 12, button: "left", clickCount: 1 })
      // Ordinary e2e launches auto-leave unload prompts; this case needs the stay path.
      delete process.env.MERAKCODE_BROWSER_LEAVE_UNLOAD
      dialog.showMessageBoxSync = () => 0
      BrowserWindow.getAllWindows()[0]!.close()
    })
    await expect(kit.page.getByRole("dialog")).toContainText("MRK-5021")
    expect(() => process.kill(pid, 0)).not.toThrow()
  } finally {
    await kit.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 1
    })
    await kit.page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click()
      .catch(() => {})
    server.closeAllConnections()
    server.close()
  }
})

test("closing a terminal tab stops its real local process tree before removing the tab", async ({ kit }) => {
  const pids = path.join(kit.project, "terminal-pids.txt")
  const script = path.join(kit.project, "terminal-family.mjs")
  await writeFile(
    script,
    `import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n')
if (!process.argv[2]) spawn(process.execPath, [import.meta.filename, 'child'], { detached: true, stdio: 'ignore' }).unref()
setInterval(() => {}, 100)
`,
  )
  const ids = async () => (await readFile(pids, "utf8").catch(() => "")).trim().split(/\s+/).filter(Boolean).map(Number)
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  try {
    await kit.openPanel("terminal", true)
    await kit.page.getByRole("region", { name: "终端", exact: true }).click()
    await kit.page.keyboard.type(`node "${script}"`)
    await kit.page.keyboard.press("Enter")
    await expect.poll(async () => (await ids()).length).toBe(2)
    const family = await ids()
    await kit.panel().getByRole("button", { name: "关闭 终端", exact: true }).click()
    await expect(kit.panel().getByRole("tab")).toHaveCount(0)
    expect(family.filter(alive)).toEqual([])
  } finally {
    for (const pid of await ids())
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
  }
})

test("a pending new-conversation terminal follows session creation and remains stoppable", async ({ kit }) => {
  const rpc = await kit.rpc()
  const creating = rpc.hold("terminal.create", { times: 1 })
  const pids = path.join(kit.project, "promoted-terminal-pid.txt")
  const script = path.join(kit.project, "promoted-terminal.mjs")
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pids)}, String(process.pid)); setInterval(() => {}, 100)`,
  )
  let pid: number | undefined
  try {
    await kit.openPanel("terminal", true)
    await creating.entered
    await kit.send("create conversation while terminal starts")
    await expect(kit.text("OK")).toBeVisible()
    creating.release()
    const terminal = kit.page.getByRole("region", { name: "终端", exact: true })
    await terminal.click()
    await kit.page.keyboard.type(`node "${script}"`)
    await kit.page.keyboard.press("Enter")
    await expect.poll(async () => Number(await readFile(pids, "utf8").catch(() => "0"))).toBeGreaterThan(0)
    pid = Number(await readFile(pids, "utf8"))
    await kit.panel().getByRole("button", { name: "关闭 终端", exact: true }).click()
    await expect(kit.panel().getByRole("tab")).toHaveCount(0)
    expect(() => process.kill(pid!, 0)).toThrow()
  } finally {
    creating.release()
    if (pid)
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
  }
})

test.describe("editor promotion into a worktree", () => {
  test.use({ git: true })

  test("existing files and terminal processes retain their actual directory after the first submission", async ({
    kit,
  }) => {
    const marker = path.join(kit.project, "worktree-terminal-pid.txt")
    const script = path.join(kit.project, "worktree-terminal.mjs")
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 100)`,
    )
    let pid: number | undefined
    try {
      await kit.openPanel("file")
      await kit.panel().getByRole("treeitem", { name: "notes.txt" }).click()
      const editor = kit.panel().getByRole("code").first()
      await expect(editor).toContainText("hello from e2e")
      await editor.click()
      await kit.page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
      await kit.page.keyboard.type("original directory draft")
      await kit.openPanel("terminal", true)
      await kit.page.getByRole("region", { name: "终端", exact: true }).click()
      await kit.page.keyboard.type(`node "${script}"`)
      await kit.page.keyboard.press("Enter")
      await expect.poll(async () => Number(await readFile(marker, "utf8").catch(() => "0"))).toBeGreaterThan(0)
      pid = Number(await readFile(marker, "utf8"))
      await kit.page.getByRole("button", { name: "新工作树", exact: true }).click()
      await kit.send("promote existing editor into a worktree")
      await expect(kit.text("OK")).toBeVisible()
      expect(() => process.kill(pid!, 0)).not.toThrow()
      await kit.panel().getByRole("button", { name: "关闭 终端", exact: true }).click()
      await expect(kit.panel().getByRole("tab")).toHaveCount(1)
      expect(() => process.kill(pid!, 0)).toThrow()
      await expect(editor).toContainText("original directory draft")
      await editor.click()
      await kit.page.keyboard.press("ControlOrMeta+S")
      await expect
        .poll(() => readFile(path.join(kit.project, "notes.txt"), "utf8"))
        .toContain("original directory draft")
      const worktree = kit
        .git("worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree "))[1]!
        .slice("worktree ".length)
      expect(await readFile(path.join(worktree, "notes.txt"), "utf8")).toBe("hello from e2e\n")
    } finally {
      if (pid)
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
    }
  })
})
