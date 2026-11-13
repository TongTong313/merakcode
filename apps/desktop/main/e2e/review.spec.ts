import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { connect, EngineEventSchema } from "@merakcode/sdk"
import { execFileSync } from "node:child_process"
import type { DesktopBridge } from "../../renderer/src/desktop/bridge-contract"
import { test, expect, type Kit } from "./fixture"

test.beforeEach(async ({ kit }) => {
  await kit.page.addLocatorHandler(
    kit.approval(),
    async () => {
      await kit.approval().getByRole("button", { name: "允许这一次", exact: true }).click()
    },
    { noWaitAfter: true },
  )
})

// Review the working directory against the conversation baseline using the real engine.

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join("")
const changed = lines(30).replace("line 2\n", "two\n").replace("line 20\n", "twenty\n")

/**
 * Reads src/math.js, changes lines 2 and 20, then creates src/new.js; when a review comment arrives, replies whether
 * it included the file
 */
const agent = (kit: () => Kit) => ({
  reply: ({ prompt, toolResults }: { prompt: string; toolResults: string[] }) => {
    if (prompt.includes("这里改成 2")) {
      lastFeedback = prompt
      return { text: `收到评论：${prompt.includes("src/math.js") ? "带文件" : "没带文件"}` }
    }
    if (prompt.includes("identical hunks")) {
      const steps = [
        { tool: "read_file", args: { path: path.join(kit().project, "src/a.js") } },
        { tool: "write_file", args: { path: path.join(kit().project, "src/a.js"), content: changed } },
        { tool: "read_file", args: { path: path.join(kit().project, "src/b.js") } },
        { tool: "write_file", args: { path: path.join(kit().project, "src/b.js"), content: changed } },
        { text: "改好了" },
      ]
      return steps[toolResults.length]!
    }
    if (prompt.includes("other conversation"))
      return toolResults.length
        ? { text: "改好了" }
        : { tool: "write_file", args: { path: path.join(kit().project, "other.txt"), content: "other conversation\n" } }
    const file = path.join(kit().project, "src", "math.js")
    const steps = [
      { tool: "read_file", args: { path: file } },
      {
        tool: "write_file",
        args: {
          path: file,
          content: prompt.includes("with blank lines") ? "const a = 2\n\nconst b = 3\n" : changed,
        },
      },
      {
        tool: "write_file",
        args: { path: path.join(kit().project, "src", "new.js"), content: "export const x = 1\n" },
      },
      ...(prompt.includes("many files")
        ? ["a", "b", "c", "d", "e", "f"].map((name) => ({
            tool: "write_file",
            args: { path: path.join(kit().project, `${name}.txt`), content: `${name}\n` },
          }))
        : []),
      { text: "改好了" },
    ]
    return steps[toolResults.length]!
  },
})

async function prepare(kit: Kit) {
  await mkdir(path.join(kit.project, "src"), { recursive: true })
  await writeFile(path.join(kit.project, "src", "math.js"), lines(30))
  kit.git("add", ".")
  kit.git("commit", "--quiet", "-m", "Math fixture")
}

const hunk = (kit: Kit, n: number) =>
  kit.panel().getByRole("group", { name: new RegExp(`^src/math\\.js (第 ${n} 块|hunk ${n})$`) })

let lastFeedback = ""
let current: Kit
test.use({ git: true, script: agent(() => current) })

test("rejects and accepts hunks with undo, then reviews in full window and returns", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("改一下 math.js")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })

  const panel = kit.panel()
  // The Review button on this turn's change card opens review in the side panel
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await expect(panel.getByRole("radio", { name: "本轮" })).toBeChecked()
  await expect(panel.getByRole("region", { name: "src/math.js" })).toBeVisible()
  await expect(panel.getByRole("region", { name: "src/new.js" })).toBeVisible()
  await expect(hunk(kit, 1)).toBeVisible()
  await expect(hunk(kit, 2)).toBeVisible()

  // Reject hunk 2: line 20 is restored, the line 2 change stays
  await hunk(kit, 2).getByRole("button", { name: "拒绝" }).click()
  await expect
    .poll(() => readFile(path.join(kit.project, "src", "math.js"), "utf8"))
    .toBe(lines(30).replace("line 2\n", "two\n"))
  await expect(hunk(kit, 2)).toHaveCount(0)

  // Undo: the line 20 change is back and can be reviewed again
  await panel.getByRole("button", { name: "撤销" }).click()
  await expect.poll(() => readFile(path.join(kit.project, "src", "math.js"), "utf8")).toBe(changed)
  await expect(hunk(kit, 2)).toBeVisible()

  // Accept hunk 1: the file is unchanged and the hunk is no longer listed
  await hunk(kit, 1).getByRole("button", { name: "接受" }).click()
  await expect(panel.getByRole("group", { name: /^src\/math\.js 第 \d 块$/ })).toHaveCount(1)
  expect(await readFile(path.join(kit.project, "src", "math.js"), "utf8")).toBe(changed)

  // Rejecting a whole new file deletes it
  await panel.getByRole("region", { name: "src/new.js" }).getByRole("button", { name: "拒绝文件" }).click()
  await expect(panel.getByRole("region", { name: "src/new.js" })).toHaveCount(0)
  await expect.poll(() => readFile(path.join(kit.project, "src", "new.js"), "utf8").catch(() => "gone")).toBe("gone")

  // Review in full window, then return to the conversation
  await panel.getByRole("button", { name: "铺满" }).click()
  const full = kit.page.getByRole("main", { name: "审阅" })
  await expect(full).toBeVisible()
  await expect(full.getByRole("group", { name: /^src\/math\.js 第 \d 块$/ })).toHaveCount(1)
  await full.getByRole("button", { name: "返回对话" }).click()
  await expect(full).toHaveCount(0)
  await expect(kit.page.getByRole("textbox", { name: "消息" })).toBeVisible()

  // Marking a file as viewed collapses it, and this survives a reload
  const math = panel.getByRole("region", { name: "src/math.js" })
  await math.getByRole("checkbox", { name: "已看" }).check()
  await expect(math.getByRole("group")).toHaveCount(0)
  await kit.page.reload()
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await expect(math.getByRole("checkbox", { name: "已看" })).toBeChecked()
  await expect(math.getByRole("group")).toHaveCount(0)
})

for (const changeScope of [false, true]) {
  test(`a late review list cannot change the selection after ${changeScope ? "switching scope" : "switching tabs"}`, async ({
    kit,
  }) => {
    current = kit
    const rpc = await kit.rpc()
    await prepare(kit)
    await kit.send("edit math")
    await expect(kit.text("改好了")).toBeVisible()
    await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
    await kit.panel().getByRole("button", { name: "铺满" }).click()
    let full = kit.page.getByRole("main", { name: "审阅", exact: true })
    await expect(
      full.getByRole("region", { name: "src/math.js", exact: true }).getByRole("group").first(),
    ).toBeVisible()
    await full.locator(".rt-file").filter({ hasText: "src/math.js" }).click()
    // The next list is held until the person has moved on
    const late = rpc.hold("repo.diff", { times: 1 })
    try {
      if (changeScope) await full.getByRole("radio", { name: "整个对话", exact: true }).click()
      else {
        await full.getByRole("button", { name: "返回对话" }).click()
        await kit.openPanel("browser", true)
        await kit.panel().getByRole("tab", { name: "审阅", exact: true }).click()
        await kit.panel().getByRole("button", { name: "铺满" }).click()
        full = kit.page.getByRole("main", { name: "审阅", exact: true })
        await full.locator(".rt-file").filter({ hasText: "src/new.js" }).click()
        await expect(full.locator(".rt-file").filter({ hasText: "src/new.js" })).toHaveClass(/on/)
      }
      late.release()
      await expect(
        full.getByRole("region", { name: "src/math.js", exact: true }).getByRole("group").first(),
      ).toBeVisible()
      if (!changeScope) await expect(full.locator(".rt-file").filter({ hasText: "src/new.js" })).toHaveClass(/on/)
      await full.getByRole("button", { name: "返回对话" }).click()
    } finally {
      late.release()
    }
  })
}

test("manual review folding survives restarting the local service", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("edit math")
  await expect(kit.text("改好了")).toBeVisible()
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const math = kit.panel().getByRole("region", { name: "src/math.js", exact: true })
  await math.getByRole("button", { name: "收起", exact: true }).click()
  await expect(math.getByRole("group")).toHaveCount(0)
  await kit.page
    .evaluate(() =>
      (window as unknown as { __MERAKCODE_DESKTOP__: DesktopBridge }).__MERAKCODE_DESKTOP__.restartBackend(),
    )
    .catch(() => {})
  await kit.page.reload()
  await expect(math).toBeVisible()
  await expect(math.getByRole("button", { name: "展开", exact: true })).toBeVisible()
  await expect(math.getByRole("group")).toHaveCount(0)
})

for (const hiding of [false, true]) {
  test(`feedback accepted after ${hiding ? "hiding the panel" : "switching tabs"} is cleared from the submitting tab`, async ({
    kit,
  }) => {
    current = kit
    const rpc = await kit.rpc()
    await prepare(kit)
    await kit.send("edit math")
    await expect(kit.text("改好了")).toBeVisible()
    await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
    const first = kit.panel().getByRole("tab", { name: "审阅", exact: true })
    await hunk(kit, 1).locator(".line.add .line-comment-add").click()
    await kit.panel().getByRole("textbox", { name: "评论" }).fill("这里改成 2")
    await kit.panel().getByRole("button", { name: "添加", exact: true }).click()
    const sending = rpc.hold("session.send", { times: 1 })
    try {
      await kit.panel().getByRole("button", { name: "发给智能体" }).click()
      await sending.entered
      if (hiding) await kit.page.getByRole("button", { name: "右侧面板", exact: true }).click()
      else await kit.openPanel("browser", true)
      sending.release()
      await expect(kit.text("收到评论：带文件")).toBeVisible()
      if (hiding) await kit.page.getByRole("button", { name: "右侧面板", exact: true }).click()
      await first.click()
      await expect(kit.panel().getByText(/1 条评论待发送/)).toHaveCount(0)
    } finally {
      sending.release()
    }
  })
}

test("side review places the file list beside a full-height review column", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("edit math")
  await expect(kit.text("改好了")).toBeVisible()
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await expect(hunk(kit, 1)).toBeVisible()
  const geometry = async () => {
    const diff = (await kit.panel().locator(".diff").boundingBox())!
    const tree = (await kit.panel().getByRole("complementary", { name: "文件", exact: true }).boundingBox())!
    const toolbar = (await kit.panel().locator(".review-sub").boundingBox())!
    expect(toolbar.height).toBeLessThan(80)
    expect(tree.x).toBeGreaterThanOrEqual(diff.x + diff.width - 2)
    expect(Math.abs(tree.y - toolbar.y)).toBeLessThan(3)
    expect(tree.height).toBeGreaterThan(diff.height / 2)
  }
  await geometry()
  await kit.panel().getByRole("button", { name: "铺满" }).click()
  await kit.page.getByRole("main", { name: "审阅", exact: true }).getByRole("button", { name: "返回对话" }).click()
  await geometry()
  await kit.page.screenshot({ path: test.info().outputPath("review-layout.png") })
})

test("message navigation reuses the review tab and restores viewed and expanded state", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("edit math")
  await expect(kit.text("改好了")).toBeVisible()
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const first = kit.panel().getByRole("tab", { name: "审阅", exact: true })
  const math = kit.panel().getByRole("region", { name: "src/math.js", exact: true })
  await math.getByRole("checkbox", { name: "已看", exact: true }).check()
  await kit.openPanel("browser", true)
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await expect(kit.panel().getByRole("tab", { name: /^审阅/ })).toHaveCount(1)
  await expect(first).toHaveAttribute("aria-selected", "true")
  await expect(math.getByRole("checkbox", { name: "已看", exact: true })).toBeChecked()
  await kit.page.reload()
  await expect(math.getByRole("checkbox", { name: "已看", exact: true })).toBeChecked()
  await math.getByRole("checkbox", { name: "已看", exact: true }).uncheck()
  await expect(math.getByRole("checkbox", { name: "已看", exact: true })).not.toBeChecked()
  await expect(math.getByRole("group")).not.toHaveCount(0)
})

for (const action of ["immediate", "accept", "undo"])
  test(
    action === "undo"
      ? "a late Git review snapshot cannot hide a file restored by undo after leaving review"
      : action === "accept"
        ? "a late Git review snapshot cannot restore a file accepted after leaving review"
        : "Git staging preserves pending review and accepting removes only review navigation",
    async ({ kit }) => {
      const delayed = action !== "immediate"
      const undo = action === "undo"
      current = kit
      const rpc = await kit.rpc()
      await prepare(kit)
      await kit.send("Update math")
      await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
      await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
      const panel = kit.panel()
      await kit.openPanel("git")
      const unstaged = panel.locator('[data-group="unstaged"] .git-file').filter({ hasText: "src/new.js" })
      await expect(unstaged.getByRole("button", { name: "查看待审改动 src/new.js" })).toBeVisible()
      await unstaged.getByRole("button", { name: "暂存 src/new.js", exact: true }).click()
      await expect.poll(() => kit.git("diff", "--cached", "--name-only").trim()).toBe("src/new.js")
      const staged = panel.locator('[data-group="staged"] .git-file').filter({ hasText: "src/new.js" })
      await staged.getByRole("button", { name: "查看待审改动 src/new.js" }).click()
      await expect(panel.getByRole("tab", { name: /^审阅/, selected: true })).toBeVisible()
      if (undo) {
        await panel.getByRole("region", { name: "src/new.js" }).getByRole("button", { name: "接受文件" }).click()
        await expect(panel.getByRole("region", { name: "src/new.js" })).toHaveCount(0)
      }
      // The review list that follows the decision arrives late, after the person has gone back to Git
      const snapshot = delayed ? rpc.holdResponse("repo.diff", { times: 1 }) : undefined
      try {
        if (undo) await panel.getByRole("button", { name: "撤销", exact: true }).click()
        else await panel.getByRole("region", { name: "src/new.js" }).getByRole("button", { name: "接受文件" }).click()
        await kit.openPanel("git")
        if (snapshot) {
          await snapshot.entered
          snapshot.release()
        }
        await expect(staged).toBeVisible()
        await expect(staged.getByRole("button", { name: /查看待审改动/ })).toHaveCount(undo ? 1 : 0)
        await expect.poll(() => kit.git("diff", "--cached", "--name-only").trim()).toBe("src/new.js")
      } finally {
        snapshot?.release()
      }
    },
  )

test("feedback relocated while sending remains pending after the original request succeeds", async ({ kit }) => {
  current = kit
  const rpc = await kit.rpc()
  await mkdir(path.join(kit.project, "src"), { recursive: true })
  await writeFile(path.join(kit.project, "src/a.js"), lines(30))
  await writeFile(path.join(kit.project, "src/b.js"), lines(30))
  kit.git("add", ".")
  kit.git("commit", "--quiet", "-m", "identical files")
  await kit.send("identical hunks")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  await panel.getByRole("radio", { name: "整个对话", exact: true }).click()
  const source = panel.getByRole("region", { name: "src/a.js" })
  const destination = panel.getByRole("region", { name: "src/b.js" })
  await source.locator(".line.add .line-comment-add").first().click()
  await panel.getByRole("textbox", { name: "评论", exact: true }).fill("这里改成 2 — preserve the new location")
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  const sending = rpc.hold("session.send", { times: 1 })
  try {
    await panel.getByRole("button", { name: "发给智能体" }).click()
    await sending.entered
    await source.getByRole("button", { name: "接受文件" }).click()
    await expect(source).toHaveCount(0)
    await panel.locator(".pending-comment-list summary").click()
    await panel.locator(".pending-comment-list").getByRole("button", { name: "编辑评论" }).click()
    await destination.locator(".line.add .line-comment-add").first().click()
    await panel.getByRole("button", { name: "添加", exact: true }).click()
    await expect(destination.locator(".line-comment")).toContainText("preserve the new location")
    sending.release()
    await expect(kit.text("收到评论：没带文件")).toBeVisible({ timeout: 60_000 })
    await expect(panel.getByRole("button", { name: "发给智能体" })).toBeEnabled()
    await expect(destination.locator(".line-comment")).toContainText("preserve the new location")
    await expect(panel.getByText(/1 条评论待发送/)).toBeVisible()
    expect(lastFeedback).toContain("src/a.js:2")
    expect(lastFeedback).not.toContain("src/b.js")
  } finally {
    sending.release()
  }
})

test("failed comment submission keeps feedback available for retry", async ({ kit }) => {
  current = kit
  const rpc = await kit.rpc()
  await prepare(kit)
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  await hunk(kit, 1).locator(".line.add .line-comment-add").click()
  await panel.getByRole("textbox", { name: "评论", exact: true }).fill("这里改成 2")
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  rpc.fail("session.send", "MRK-1001")
  await panel.getByRole("button", { name: "发给智能体" }).click()
  await expect(panel.getByText(/1 条评论待发送/)).toBeVisible()
  await expect(panel.getByRole("button", { name: "发给智能体" })).toBeEnabled()
  await panel.getByRole("button", { name: "发给智能体" }).click()
  await expect(kit.text("收到评论：带文件")).toBeVisible({ timeout: 60_000 })
  await expect(panel.getByText(/1 条评论待发送/)).toHaveCount(0)
})

test("a selected turn cannot leak into another conversation", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await kit.page.getByRole("button", { name: "新对话", exact: true }).click()
  await kit.mode(/全面接管|Full takeover/)
  await kit.send("other conversation")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await expect(kit.panel()).toBeHidden()
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await expect(kit.panel().getByRole("region", { name: "other.txt" })).toBeVisible({ timeout: 10000 })
  await expect(kit.panel().getByRole("region", { name: "src/math.js" })).toHaveCount(0)
})

test("accepting a draft's file keeps its feedback available for relocation", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  await hunk(kit, 1).locator(".line.add .line-comment-add").click()
  await panel.getByRole("textbox", { name: "评论", exact: true }).fill("Keep feedback after accepting the file")
  await panel.getByRole("region", { name: "src/math.js" }).getByRole("button", { name: "接受文件" }).click()
  await expect(panel.getByRole("region", { name: "src/math.js" })).toHaveCount(0)
  await expect(panel.getByRole("textbox", { name: "评论", exact: true })).toHaveValue(
    "Keep feedback after accepting the file",
  )
  await expect(panel.getByRole("button", { name: "添加", exact: true })).toBeDisabled()
  const added = panel.getByRole("region", { name: "src/new.js" })
  await added.locator(".line.add .line-comment-add").click()
  await expect(panel.getByRole("textbox", { name: "评论", exact: true })).toHaveValue(
    "Keep feedback after accepting the file",
  )
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await expect(added.locator(".line-comment")).toContainText("Keep feedback after accepting the file")
})

test("a comment on a hunk is sent to the agent with the file, lines and comment", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("改一下 math.js")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })

  const panel = kit.panel()
  // The Review button on this turn's change card opens review in the side panel
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await hunk(kit, 1).locator(".line.add").hover()
  await hunk(kit, 1).locator(".line.add .line-comment-add").click()
  await panel.getByRole("textbox", { name: "评论" }).fill("这里改成 2")
  await panel.getByRole("button", { name: "添加" }).click()
  await expect(panel.getByText(/1 条评论待发送/)).toBeVisible()
  await panel.getByRole("button", { name: "发给智能体" }).click()
  await expect(kit.text("收到评论：带文件")).toBeVisible({ timeout: 60_000 })
})

test("many changed files start collapsed, and opening one loads its hunks", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("many files")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })

  const panel = kit.panel()
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const math = panel.getByRole("region", { name: "src/math.js" })
  await expect(math).toBeVisible()
  await expect(math.getByRole("group")).toHaveCount(0)
  await math.getByRole("button", { name: "展开" }).click()
  await expect(math.getByRole("group")).toHaveCount(2)
})

test("dragging code through a refresh preserves the exact selected excerpt", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const first = hunk(kit, 1).locator(".line.add .code")
  const next = hunk(kit, 1)
    .locator(".line.context .code")
    .filter({ hasText: /^line 3$/ })
  const start = await first.boundingBox()
  const end = await next.boundingBox()
  await kit.page.mouse.move(start!.x + 1, start!.y + start!.height / 2)
  await kit.page.mouse.down()
  const panel = kit.panel()
  await panel.getByRole("button", { name: "刷新 Git 状态" }).evaluate((button: HTMLButtonElement) => button.click())
  await expect(panel.getByRole("status", { name: "正在更新" })).toBeHidden()
  await kit.page.mouse.move(end!.x + 44, end!.y + end!.height / 2, { steps: 12 })
  await kit.page.mouse.up()
  await expect(panel.getByRole("textbox", { name: "评论", exact: true })).toHaveCount(0)
  await panel.getByRole("button", { name: "评论所选代码" }).click()
  await panel.getByRole("textbox", { name: "评论", exact: true }).fill("这里改成 2")
  await kit.page.screenshot({ path: test.info().outputPath("inline-comment.png") })
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await panel.getByRole("button", { name: "发给智能体" }).click()
  await expect(kit.text("收到评论：带文件")).toBeVisible({ timeout: 60_000 })
  expect(lastFeedback).toContain("src/math.js:2–3")
  expect(lastFeedback).toContain("+two\n line 3")
  expect(lastFeedback).not.toContain("-line 2")
})

test("native selections ending at a line start include only the preceding code in either direction", async ({
  kit,
}) => {
  current = kit
  await prepare(kit)
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  for (const backwards of [false, true]) {
    const selected = await hunk(kit, 1).evaluate((element, backwards) => {
      const first = element.querySelector(".line.add .code")!
      const last = [...element.querySelectorAll(".line.context .code")].find((code) => code.textContent === "line 3")!
      const start = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()!
      const end = document.createTreeWalker(last, NodeFilter.SHOW_TEXT).nextNode()!
      const selection = window.getSelection()!
      selection.setBaseAndExtent(backwards ? end : start, 0, backwards ? start : end, 0)
      const text = selection.toString()
      last.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
      return text
    }, backwards)
    expect(selected).not.toContain("line 3")
    await panel.getByRole("button", { name: "评论所选代码" }).click()
    await panel.getByRole("textbox", { name: "评论", exact: true }).fill("这里改成 2")
    await panel.getByRole("button", { name: "添加", exact: true }).click()
    const feedback = panel.locator(".line-comment")
    await expect(feedback.locator(".comment-excerpt")).toHaveText("+two")
    await expect(feedback.locator(".comment-location")).toHaveText("src/math.js:2")
    await feedback.getByRole("button", { name: "删除", exact: true }).click()
  }
})

test("selecting across highlighted blank lines retains them in the comment excerpt", async ({ kit }) => {
  current = kit
  await mkdir(path.join(kit.project, "src"), { recursive: true })
  await writeFile(path.join(kit.project, "src/math.js"), "const a = 1\n\nconst b = 2\n")
  kit.git("add", ".")
  kit.git("commit", "--quiet", "-m", "Blank lines fixture")
  await kit.send("Update math with blank lines")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await kit.panel().getByRole("button", { name: "铺满" }).click()
  const full = kit.page.getByRole("main", { name: "审阅" })
  const math = full.getByRole("region", { name: "src/math.js" })
  const added = math.locator('.line.add[data-side="new"] .code')
  await expect(added.first().locator("span").first()).toBeAttached()
  const blank = math.locator('.line.context[data-side="new"] .code')
  await expect.poll(() => blank.textContent()).toBe("")
  await math.evaluate((element) => {
    const codes = element.querySelectorAll('.line.add[data-side="new"] .code')
    const start = document.createTreeWalker(codes[0]!, NodeFilter.SHOW_TEXT).nextNode()!
    const walker = document.createTreeWalker(codes[codes.length - 1]!, NodeFilter.SHOW_TEXT)
    let end = walker.nextNode()!
    while (walker.nextNode()) end = walker.currentNode
    window.getSelection()!.setBaseAndExtent(start, 0, end, end.textContent!.length)
    codes[codes.length - 1]!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  })
  await full.getByRole("button", { name: "评论所选代码" }).click()
  await full.getByRole("textbox", { name: "评论", exact: true }).fill("Keep the selected blank line")
  await full.getByRole("button", { name: "添加", exact: true }).click()
  expect(await full.locator(".comment-excerpt").textContent()).toBe("+const a = 2\n \n+const b = 3")
  await expect(full.locator(".line-comment .comment-location")).toHaveText("src/math.js:1–3")
})

test("full-screen shortcuts target the selected file when two files have identical hunks", async ({ kit }) => {
  current = kit
  await mkdir(path.join(kit.project, "src"), { recursive: true })
  await writeFile(path.join(kit.project, "src/a.js"), lines(30))
  await writeFile(path.join(kit.project, "src/b.js"), lines(30))
  kit.git("add", ".")
  kit.git("commit", "--quiet", "-m", "Two files fixture")
  await kit.send("identical hunks")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await kit.panel().getByRole("button", { name: "铺满" }).click()
  const full = kit.page.getByRole("main", { name: "审阅" })
  const selectB = async () => {
    const file = full.locator(".rt-file").filter({ hasText: "src/b.js" })
    await file.click()
    await expect(file).toHaveClass(/on/)
  }
  await selectB()
  await kit.page.keyboard.press("c")
  await full.getByRole("textbox", { name: "评论", exact: true }).fill("Feedback for B")
  await full.getByRole("button", { name: "添加", exact: true }).click()
  await expect(full.getByRole("region", { name: "src/b.js" }).locator(".line-comment")).toContainText("Feedback for B")
  await expect(full.getByRole("region", { name: "src/a.js" }).locator(".line-comment")).toHaveCount(0)
})

test("a new conversation uses its own committed baseline", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  kit.git("add", ".")
  kit.git("commit", "--quiet", "-m", "Reviewed baseline")
  await kit.page.getByRole("button", { name: "新对话", exact: true }).click()
  await kit.send("other conversation")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  // Each conversation has its own panel: open the review of this one
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await expect(kit.panel().getByRole("region", { name: "other.txt" })).toBeVisible({ timeout: 10000 })
  await expect(kit.panel().getByRole("region", { name: "src/math.js" })).toHaveCount(0)
})

test("saved old-side feedback reveals and highlights its line after returning to the panel", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await kit.panel().getByRole("button", { name: "铺满" }).click()
  const full = kit.page.getByRole("main", { name: "审阅" })
  const deleted = full.locator('.line.del[data-side="old"]').nth(1)
  await deleted.hover()
  await deleted.locator(".line-comment-add").click()
  await full.getByRole("textbox", { name: "评论", exact: true }).fill("Feedback on deleted line 20")
  await full.getByRole("button", { name: "添加", exact: true }).click()
  await full.getByRole("button", { name: /^返回/ }).click()
  const panel = kit.panel()
  await panel.locator(".pending-comment-list summary").click()
  await panel.locator(".pending-comment-list .comment-location").click()
  const target = panel.locator('.line.del[data-side="unified"]').filter({ hasText: "line 20" })
  await expect(target).toBeInViewport()
  await expect
    .poll(() =>
      target.evaluate((element) => element.getAnimations().some((animation) => animation.playState === "running")),
    )
    .toBe(true)
  await kit.page.screenshot({ path: test.info().outputPath("comment-location.png") })
})

test("relocating a stale draft preserves feedback already drafted on the target line", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  const added = panel.getByRole("region", { name: "src/new.js" })
  await added.locator(".line.add .line-comment-add").click()
  await panel.getByRole("textbox", { name: "评论", exact: true }).fill("Independent draft B")
  await kit.page.keyboard.press("Escape")
  await hunk(kit, 1).locator(".line.add .line-comment-add").click()
  await panel.getByRole("textbox", { name: "评论", exact: true }).fill("Feedback A to relocate")
  await writeFile(path.join(kit.project, "src/math.js"), changed.replace("two\n", "replacement\n"))
  await panel.getByRole("toolbar", { name: "审阅工具栏" }).getByRole("button", { name: "刷新" }).click()
  await expect(panel.getByText("代码或工作分支已变化；草稿已保留，请重新选择评论位置。")).toBeVisible()
  await added.locator(".line.add .line-comment-add").click()
  await expect(panel.getByRole("textbox", { name: "评论", exact: true })).toHaveValue("Feedback A to relocate")
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await expect(added.locator(".line-comment")).toContainText("Feedback A to relocate")
  await panel.locator(".review-draft").filter({ hasText: "Independent draft B" }).getByRole("button").first().click()
  await expect(panel.getByRole("textbox", { name: "评论", exact: true })).toHaveValue("Independent draft B")
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await expect(added.locator(".line-comment")).toHaveCount(2)
})

test("restoring a file preserves its draft for relocation", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  await hunk(kit, 1).locator(".line.add .line-comment-add").click()
  await panel.getByRole("textbox", { name: "评论", exact: true }).fill("Keep feedback after restoring the file")
  await writeFile(path.join(kit.project, "src/math.js"), lines(30))
  await panel.getByRole("toolbar", { name: "审阅工具栏" }).getByRole("button", { name: "刷新" }).click()
  await expect(panel.getByRole("region", { name: "src/math.js" })).toHaveCount(0)
  await expect(panel.getByRole("textbox", { name: "评论", exact: true })).toHaveValue(
    "Keep feedback after restoring the file",
  )
  await expect(panel.getByRole("button", { name: "添加", exact: true })).toBeDisabled()
  const added = panel.getByRole("region", { name: "src/new.js" })
  await added.locator(".line.add .line-comment-add").click()
  await expect(panel.getByRole("textbox", { name: "评论", exact: true })).toHaveValue(
    "Keep feedback after restoring the file",
  )
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await expect(added.locator(".line-comment")).toContainText("Keep feedback after restoring the file")
})

test("saving an edit after its original comment was sent retains the new feedback", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  await hunk(kit, 1).locator(".line.add .line-comment-add").click()
  await panel.getByRole("textbox", { name: "评论", exact: true }).fill("这里改成 2 — original feedback")
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await panel.locator(".line-comment").getByRole("button", { name: "编辑评论" }).click()
  await panel.getByRole("textbox", { name: "评论", exact: true }).fill("Keep this edited feedback after sending A")
  await panel.getByRole("button", { name: "发给智能体" }).click()
  await expect(kit.text("收到评论：带文件")).toBeVisible({ timeout: 60_000 })
  await expect(panel.locator(".pending-comments")).toHaveCount(0)
  await expect(panel.getByRole("textbox", { name: "评论", exact: true })).toHaveValue(
    "Keep this edited feedback after sending A",
  )
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await expect(panel.locator(".line-comment")).toContainText("Keep this edited feedback after sending A", {
    timeout: 5000,
  })
  await expect(panel.getByText(/1 条评论待发送/)).toBeVisible()
})

test("resuming and remounting a relocated draft preserves a newer source draft", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  await hunk(kit, 1).locator(".line.add .line-comment-add").click()
  await panel.getByRole("textbox", { name: "评论", exact: true }).fill("Relocated draft B")
  await writeFile(path.join(kit.project, "src/math.js"), lines(30))
  await panel.getByRole("toolbar", { name: "审阅工具栏" }).getByRole("button", { name: "刷新" }).click()
  await expect(panel.getByRole("region", { name: "src/math.js" })).toHaveCount(0)
  await panel.getByRole("region", { name: "src/new.js" }).locator(".line.add .line-comment-add").click()
  await kit.page.keyboard.press("Escape")
  await writeFile(path.join(kit.project, "src/math.js"), changed)
  await panel.getByRole("toolbar", { name: "审阅工具栏" }).getByRole("button", { name: "刷新" }).click()
  await hunk(kit, 1).locator(".line.add .line-comment-add").click()
  await panel.getByRole("textbox", { name: "评论", exact: true }).fill("New source draft C")
  await kit.page.keyboard.press("Escape")
  await panel.locator(".review-draft").filter({ hasText: "Relocated draft B" }).getByRole("button").first().click()
  await expect(panel.getByRole("textbox", { name: "评论", exact: true })).toHaveValue("Relocated draft B")
  await expect(panel.locator(".review-draft").filter({ hasText: "New source draft C" })).toBeVisible()
  await panel.getByRole("button", { name: "铺满" }).click()
  const full = kit.page.getByRole("main", { name: "审阅" })
  await expect(full.getByRole("textbox", { name: "评论", exact: true })).toHaveValue("Relocated draft B")
  await expect(full.locator(".review-draft").filter({ hasText: "New source draft C" })).toBeVisible()
  await full.getByRole("button", { name: /^返回/ }).click()
  await expect(panel.getByRole("textbox", { name: "评论", exact: true })).toHaveValue("Relocated draft B")
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await panel.locator(".review-draft").filter({ hasText: "New source draft C" }).getByRole("button").first().click()
  await expect(panel.getByRole("textbox", { name: "评论", exact: true })).toHaveValue("New source draft C")
})

test.describe("task artifact review", () => {
  test.use({ modelWindow: 128000 })
  let rpc: Awaited<ReturnType<typeof connect>>
  let taskID = ""
  let claimID = ""
  let groupID = ""
  let published = false
  test.use({
    script: {
      reply: async ({ tools, prompt }) => {
        if (tools.includes("submit_report")) {
          const facts = (await rpc.events.read({ stream: `group:${groupID}`, from: 1 }))!.map((event) =>
            EngineEventSchema.parse(event),
          )
          const created = facts.findLast((event) => event.type === "workspace.created")
          if (created?.type !== "workspace.created") throw new Error("Claim workspace is missing")
          await writeFile(path.join(created.payload.directory, "report.txt"), "Published artifact content\n")
          return {
            tool: "submit_report",
            args: {
              verdict: "done",
              summary: "Artifact is ready for review.",
              artifacts: [{ path: "report.txt", title: "Review document", mediaType: "text/plain" }],
              checks: [{ command: "check report", exitCode: 0 }],
            },
          }
        }
        if (prompt.includes("Publish report now") && !published) {
          published = true
          return { tool: "publish", args: { task: taskID, claim: claimID } }
        }
        return { text: "Waiting for review." }
      },
    },
  })
  test("downloads a published task artifact and approves its final delivery", async ({ kit }, info) => {
    await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
    const dialog = kit.page.getByRole("dialog")
    await dialog.getByRole("textbox", { name: "群名称" }).fill("产物审核")
    await dialog.getByRole("checkbox", { name: "选择 MerakCode", exact: true }).check()
    await dialog.getByRole("button", { name: "创建", exact: true }).click()
    await expect(kit.page.getByRole("log", { name: "群聊", exact: true })).toBeVisible()
    const engineInfo = JSON.parse(await readFile(path.join(kit.root, "data", "engine.json"), "utf8")) as {
      endpoint: string
      token: string
    }
    expect(new URL(engineInfo.endpoint).hostname).toBe("127.0.0.1")
    rpc = await connect(engineInfo)
    try {
      const created = (await rpc.events.find({ types: ["group.created"] }))!.map((event) =>
        EngineEventSchema.parse(event),
      )[0]!
      if (created.type !== "group.created") throw new Error("Group is missing")
      groupID = created.payload.group.id
      const worker = (await rpc.group.state({ group: groupID })).members!.find((member) => member.role === "worker")!
      const card = await rpc.task.create({
        group: groupID,
        title: "审核文档",
        member: worker.id,
        workspace: "folder",
        review: true,
      })
      taskID = card.id
      const facts = async () =>
        (await rpc.events.read({ stream: `group:${groupID}`, from: 1 }))!.map((event) => EngineEventSchema.parse(event))
      await expect
        .poll(async () =>
          (await facts()).some((event) => event.type === "task.reported" && event.scope.task === taskID),
        )
        .toBe(true)
      const reported = (await facts()).find((event) => event.type === "task.reported" && event.scope.task === taskID)!
      if (reported.type !== "task.reported") throw new Error("Report is missing")
      claimID = reported.payload.claims![0]!.id
      await kit.page.getByRole("link", { name: "首页", exact: true }).click()
      await kit.page
        .getByRole("article")
        .filter({ hasText: "审核文档" })
        .getByRole("button", { name: "去处理", exact: true })
        .click()
      await kit.page.getByRole("button", { name: "审核任务", exact: true }).click()
      const review = kit.page.getByRole("region", { name: "任务审核", exact: true })
      await expect(review).toContainText("Artifact is ready for review.")
      await expect(review).toContainText("等待队长发布")
      await expect(review.getByRole("button", { name: "通过", exact: true })).toBeDisabled()
      await rpc.group.say({
        group: groupID,
        task: taskID,
        to: [created.payload.group.leader!],
        text: "Publish report now",
      })
      await expect(review.getByRole("button", { name: "下载 Review document", exact: true })).toBeVisible()
      const artifact = (await facts()).find((event) => event.type === "artifact.published")!
      if (artifact.type !== "artifact.published") throw new Error("Published artifact is missing")
      expect(new TextDecoder().decode(await rpc.blob.get(`mrk://blob/${artifact.payload.id}`))).toBe(
        "Published artifact content\n",
      )
      const downloadPath = path.join(kit.root, "downloaded-report.txt")
      await kit.app.evaluate(({ session }, destination) => {
        session.defaultSession.once("will-download", (_event, item) => {
          item.setSavePath(destination)
          ;(globalThis as unknown as { downloadedName: string }).downloadedName = item.getFilename()
        })
      }, downloadPath)
      await review.getByRole("button", { name: "下载 Review document", exact: true }).click()
      await expect.poll(() => readFile(downloadPath, "utf8").catch(() => "")).toBe("Published artifact content\n")
      expect(await kit.app.evaluate(() => (globalThis as unknown as { downloadedName: string }).downloadedName)).toBe(
        "report.txt",
      )
      await rpc.task.update({ task: taskID, phase: "doing" })
      await rpc.task.update({ task: taskID, phase: "integrating" })
      await expect
        .poll(async () =>
          (await facts()).some((event) => event.type === "phase.changed" && event.payload.phase === "review"),
        )
        .toBe(true)
      await review.getByRole("button", { name: "通过", exact: true }).click()
      await expect
        .poll(async () =>
          (await facts()).some((event) => event.type === "phase.changed" && event.payload.phase === "done"),
        )
        .toBe(true)
      await expect(review).toContainText("已通过")
    } finally {
      await info.attach("fake-model-requests", {
        body: JSON.stringify(kit.modelRequests(), null, 2),
        contentType: "application/json",
      })
      await rpc.close()
    }
  })
})

test.describe("task worktree review", () => {
  test.use({ modelWindow: 128000 })
  let rpc: Awaited<ReturnType<typeof connect>>
  let groupID = ""
  let fixture: Kit
  let revision = 0
  test.use({
    script: {
      reply: async ({ tools }) => {
        if (!tools.includes("submit_report")) return { text: "Waiting for review." }
        const events = (await rpc.events.read({ stream: `group:${groupID}`, from: 1 }))!.map((event) =>
          EngineEventSchema.parse(event),
        )
        const workspace = events.findLast((event) => event.type === "workspace.created")
        if (workspace?.type !== "workspace.created") throw new Error("Workspace is missing")
        const directory = workspace.payload.directory
        const relative = path.relative(fixture.root, directory)
        expect(relative.startsWith("..")).toBe(false)
        expect(path.isAbsolute(relative)).toBe(false)
        revision++
        await writeFile(
          path.join(directory, "notes.txt"),
          revision === 1 ? "Reviewed notes\n" : "Reviewed notes with examples\n",
        )
        execFileSync("git", ["add", "notes.txt"], { cwd: directory, windowsHide: true })
        execFileSync("git", ["commit", "-m", `Revision ${revision}`], { cwd: directory, windowsHide: true })
        return {
          tool: "submit_report",
          args: {
            verdict: "done",
            summary: `Checked revision ${revision}`,
            changes: [{ path: "notes.txt", kind: "modified", added: 1, removed: 1 }],
            checks: [{ command: "check notes", exitCode: 0 }],
          },
        }
      },
    },
  })
  test("reviews a task diff, sends combined rework feedback and returns the final goal to planning", async ({
    kit,
  }, info) => {
    fixture = kit
    await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
    const dialog = kit.page.getByRole("dialog")
    await dialog.getByRole("textbox", { name: "群名称" }).fill("代码审核")
    await dialog.getByRole("checkbox", { name: "选择 MerakCode", exact: true }).check()
    await dialog.getByRole("button", { name: "创建", exact: true }).click()
    await expect(kit.page.getByRole("log", { name: "群聊", exact: true })).toBeVisible()
    const engineInfo = JSON.parse(await readFile(path.join(kit.root, "data", "engine.json"), "utf8")) as {
      endpoint: string
      token: string
    }
    expect(new URL(engineInfo.endpoint).hostname).toBe("127.0.0.1")
    rpc = await connect(engineInfo)
    try {
      const created = (await rpc.events.find({ types: ["group.created"] }))!.map((event) =>
        EngineEventSchema.parse(event),
      )[0]!
      if (created.type !== "group.created") throw new Error("Group is missing")
      groupID = created.payload.group.id
      const worker = (await rpc.group.state({ group: groupID })).members!.find((member) => member.role === "worker")!
      const card = await rpc.task.create({
        group: groupID,
        title: "审核代码",
        member: worker.id,
        review: true,
      })
      const events = async () =>
        (await rpc.events.read({ stream: `group:${groupID}`, from: 1 }))!.map((event) => EngineEventSchema.parse(event))
      await kit.page.getByRole("link", { name: "首页", exact: true }).click()
      await kit.page
        .getByRole("article")
        .filter({ hasText: "审核代码" })
        .getByRole("button", { name: "去处理", exact: true })
        .click()
      await kit.page.getByRole("button", { name: "审核任务", exact: true }).click()
      const review = kit.page.getByRole("region", { name: "任务审核", exact: true })
      await expect(review.getByRole("region", { name: "成员报告", exact: true })).toContainText("Checked revision 1")
      const file = review.getByRole("region", { name: "notes.txt", exact: true })
      await expect(file).toContainText("hello from e2e")
      await expect(file).toContainText("Reviewed notes")
      await file.locator(".line.add .line-comment-add").click()
      await review.getByRole("textbox", { name: "评论", exact: true }).fill("保留说明")
      await review.getByRole("button", { name: "添加", exact: true }).click()
      await review.getByRole("textbox", { name: "审核意见", exact: true }).fill("补充例子")
      await review.getByRole("button", { name: "返工", exact: true }).click()
      await expect(review).toContainText("MerakCode2 已收到意见并开始返工")
      await expect(review.getByRole("region", { name: "成员报告", exact: true })).toContainText("Checked revision 2")
      expect(
        kit
          .modelRequests()
          .some(
            (request) =>
              request.prompt.includes("保留说明") &&
              request.prompt.includes("补充例子") &&
              request.prompt.includes("notes.txt"),
          ),
      ).toBe(true)
      await review.getByRole("button", { name: "通过", exact: true }).click()
      const reviewURL = kit.page.url()
      await kit.page.removeLocatorHandler(kit.approval())
      await kit.page.getByRole("link", { name: "首页", exact: true }).click()
      await kit.page
        .getByRole("article")
        .filter({ hasText: "request_merge" })
        .getByRole("button", { name: "去处理", exact: true })
        .click()
      await kit.page.getByRole("dialog").getByRole("button", { name: "允许这一次", exact: true }).click()
      await expect
        .poll(async () => (await events()).some((event) => event.type === "merge.done" && event.scope.task === card.id))
        .toBe(true)
      await kit.page.goto(reviewURL)
      await rpc.task.update({ task: card.id, phase: "doing" })
      await rpc.task.update({ task: card.id, phase: "integrating" })
      await expect(review.getByRole("button", { name: "打回规划", exact: true })).toBeVisible()
      await expect(file).toContainText("Reviewed notes with examples")
      await kit.page.screenshot({ path: info.outputPath("task-review.png") })
      await review.getByRole("textbox", { name: "审核意见", exact: true }).fill("调整目标")
      await review.getByRole("button", { name: "打回规划", exact: true }).click()
      await expect(review).toContainText("已打回规划")
      await expect
        .poll(async () =>
          (await events()).some(
            (event) =>
              event.type === "task.reviewed" &&
              event.payload.phase === "planning" &&
              event.payload.lastReview?.decision === "replan",
          ),
        )
        .toBe(true)
    } finally {
      await rpc.close()
    }
  })
})
