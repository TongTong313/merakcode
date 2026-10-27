import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { test, expect, type Kit } from "./fixture"

// Review agent changes independently of Git, including exact line feedback, full-screen navigation, and undo.

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
        { tool: "read", args: { filePath: path.join(kit().project, "src/a.js") } },
        { tool: "write", args: { filePath: path.join(kit().project, "src/a.js"), content: changed } },
        { tool: "read", args: { filePath: path.join(kit().project, "src/b.js") } },
        { tool: "write", args: { filePath: path.join(kit().project, "src/b.js"), content: changed } },
        { text: "改好了" },
      ]
      return steps[toolResults.length]!
    }
    if (prompt.includes("other conversation"))
      return toolResults.length
        ? { text: "改好了" }
        : { tool: "write", args: { filePath: path.join(kit().project, "other.txt"), content: "other conversation\n" } }
    const file = path.join(kit().project, "src", "math.js")
    const steps = [
      { tool: "read", args: { filePath: file } },
      {
        tool: "write",
        args: {
          filePath: file,
          content: prompt.includes("with blank lines") ? "const a = 2\n\nconst b = 3\n" : changed,
        },
      },
      { tool: "write", args: { filePath: path.join(kit().project, "src", "new.js"), content: "export const x = 1\n" } },
      ...(prompt.includes("many files")
        ? ["a", "b", "c", "d", "e", "f"].map((name) => ({
            tool: "write",
            args: { filePath: path.join(kit().project, `${name}.txt`), content: `${name}\n` },
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
}

const hunk = (kit: Kit, n: number) =>
  kit.panel().getByRole("group", { name: new RegExp(`^src/math\\.js (第 ${n} 块|hunk ${n})$`) })

let lastFeedback = ""
let current: Kit
test.use({ git: true, script: agent(() => current) })

test("rejects and accepts hunks with undo, then reviews in full window and returns", async ({ kit }) => {
  current = kit
  await prepare(kit)
  kit.git("add", ".")
  kit.git("commit", "--quiet", "-m", "math")
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

test("Git staging preserves pending review and accepting removes only review navigation", async ({ kit }) => {
  current = kit
  await prepare(kit)
  kit.git("add", ".")
  kit.git("commit", "--quiet", "-m", "math")
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  const unstaged = panel.locator('[data-group="unstaged"] .git-file').filter({ hasText: "src/new.js" })
  await expect(unstaged.getByRole("button", { name: "查看待审改动 src/new.js" })).toBeVisible()
  await unstaged.getByRole("button", { name: "暂存 src/new.js", exact: true }).click()
  await expect.poll(() => kit.git("diff", "--cached", "--name-only").trim()).toBe("src/new.js")
  const staged = panel.locator('[data-group="staged"] .git-file').filter({ hasText: "src/new.js" })
  await staged.getByRole("button", { name: "查看待审改动 src/new.js" }).click()
  await expect(panel.getByRole("tab", { name: /^审阅/ })).toHaveAttribute("aria-selected", "true")
  await panel.getByRole("region", { name: "src/new.js" }).getByRole("button", { name: "接受文件" }).click()
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  await expect(staged).toBeVisible()
  await expect(staged.getByRole("button", { name: /查看待审改动/ })).toHaveCount(0)
  await expect.poll(() => kit.git("diff", "--cached", "--name-only").trim()).toBe("src/new.js")
})

test("many changed files start collapsed, and opening one loads its hunks", async ({ kit }) => {
  current = kit
  await prepare(kit)
  kit.git("add", ".")
  kit.git("commit", "--quiet", "-m", "math")
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

test("dragging code selects an exact range and sends only that excerpt", async ({ kit }) => {
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
  await kit.page.mouse.move(end!.x + 44, end!.y + end!.height / 2, { steps: 12 })
  await kit.page.mouse.up()
  const panel = kit.panel()
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

test("feedback relocated while sending remains pending after the original request succeeds", async ({ kit }) => {
  current = kit
  await mkdir(path.join(kit.project, "src"), { recursive: true })
  await writeFile(path.join(kit.project, "src/a.js"), lines(30))
  await writeFile(path.join(kit.project, "src/b.js"), lines(30))
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
  let release = () => {}
  let held = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const intercepted = new Promise<void>((resolve) => {
    held = resolve
  })
  await kit.page.route(
    "**/session/*/prompt_async",
    async (route) => {
      held()
      await gate
      await route.continue()
    },
    { times: 1 },
  )
  try {
    await panel.getByRole("button", { name: "发给智能体" }).click()
    await intercepted
    await source.getByRole("button", { name: "接受文件" }).click()
    await expect(source).toHaveCount(0)
    await panel.locator(".pending-comment-list summary").click()
    await panel.locator(".pending-comment-list").getByRole("button", { name: "编辑评论" }).click()
    await destination.locator(".line.add .line-comment-add").first().click()
    await panel.getByRole("button", { name: "添加", exact: true }).click()
    await expect(destination.locator(".line-comment")).toContainText("preserve the new location")
    release()
    await expect(kit.text("收到评论：没带文件")).toBeVisible({ timeout: 60_000 })
    await expect(panel.getByRole("button", { name: "发给智能体" })).toBeEnabled()
    await expect(destination.locator(".line-comment")).toContainText("preserve the new location")
    await expect(panel.getByText(/1 条评论待发送/)).toBeVisible()
    expect(lastFeedback).toContain("src/a.js:2")
    expect(lastFeedback).not.toContain("src/b.js")
  } finally {
    release()
  }
})

test("failed comment submission keeps feedback available for retry", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  const panel = kit.panel()
  await hunk(kit, 1).locator(".line.add .line-comment-add").click()
  await panel.getByRole("textbox", { name: "评论", exact: true }).fill("这里改成 2")
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await kit.page.route("**/session/*/prompt_async", (route) => route.abort("failed"), { times: 1 })
  await panel.getByRole("button", { name: "发给智能体" }).click()
  await expect(panel.getByText(/1 条评论待发送/)).toBeVisible()
  await expect(panel.getByRole("button", { name: "发给智能体" })).toBeEnabled()
  await panel.getByRole("button", { name: "发给智能体" }).click()
  await expect(kit.text("收到评论：带文件")).toBeVisible({ timeout: 60_000 })
  await expect(panel.getByText(/1 条评论待发送/)).toHaveCount(0)
})

test("full-screen shortcuts target the selected file when two files have identical hunks", async ({ kit }) => {
  current = kit
  await mkdir(path.join(kit.project, "src"), { recursive: true })
  await writeFile(path.join(kit.project, "src/a.js"), lines(30))
  await writeFile(path.join(kit.project, "src/b.js"), lines(30))
  await kit.send("identical hunks")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await kit.panel().getByRole("button", { name: "铺满" }).click()
  const full = kit.page.getByRole("main", { name: "审阅" })
  const selectB = async () => {
    const file = full.locator(".rt-file").filter({ hasText: "src/b.js" })
    await file.click()
    await expect(file).toHaveClass(/on/)
    await expect(
      full
        .getByRole("region", { name: "src/b.js" })
        .getByRole("group")
        .first()
        .getByRole("button", { name: "拒绝", exact: true }),
    ).toBeEnabled()
  }
  await selectB()
  await kit.page.keyboard.press("r")
  await expect
    .poll(() => readFile(path.join(kit.project, "src/b.js"), "utf8"), { timeout: 10000 })
    .toBe(lines(30).replace("line 20\n", "twenty\n"))
  expect(await readFile(path.join(kit.project, "src/a.js"), "utf8")).toBe(changed)
  await full.getByRole("button", { name: "撤销" }).click()
  await expect(full.getByRole("region", { name: "src/b.js" }).locator(".hunk")).toHaveCount(2)
  await selectB()
  await kit.page.keyboard.press("c")
  await full.getByRole("textbox", { name: "评论", exact: true }).fill("Feedback for B")
  await full.getByRole("button", { name: "添加", exact: true }).click()
  await expect(full.getByRole("region", { name: "src/b.js" }).locator(".line-comment")).toContainText("Feedback for B")
  await expect(full.getByRole("region", { name: "src/a.js" }).locator(".line-comment")).toHaveCount(0)
  await selectB()
  await kit.page.keyboard.press("a")
  await expect(full.getByRole("region", { name: "src/b.js" }).locator(".hunk")).toHaveCount(1)
  await expect(full.getByRole("region", { name: "src/a.js" }).locator(".hunk")).toHaveCount(2)
})

test("a selected turn cannot leak into another conversation", async ({ kit }) => {
  current = kit
  await prepare(kit)
  await kit.send("Update math")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await kit.page.getByRole("button", { name: "新对话", exact: true }).click()
  await kit.send("other conversation")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
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
  await panel.getByRole("tab", { name: "Git 管理" }).click()
  await panel.getByRole("tab", { name: /^审阅/ }).click()
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
  await panel.getByRole("region", { name: "src/math.js" }).getByRole("button", { name: "接受文件" }).click()
  await expect(panel.getByRole("region", { name: "src/math.js" })).toHaveCount(0)
  await panel.getByRole("region", { name: "src/new.js" }).locator(".line.add .line-comment-add").click()
  await kit.page.keyboard.press("Escape")
  await panel.getByRole("button", { name: "撤销", exact: true }).click()
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
