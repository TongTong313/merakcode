import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { test, expect, type Kit } from "./fixture"

// Review: after the agent edits files, accept or reject hunks in the side panel (rejecting writes back to disk) with
// undo; send a comment on a hunk to the agent; review in full window; review unstaged git changes (accept = stage)
// and pick a base branch from the branch dropdown; many files start collapsed and load a file when it is opened

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join("")
const changed = lines(30).replace("line 2\n", "two\n").replace("line 20\n", "twenty\n")

/**
 * Reads src/math.js, changes lines 2 and 20, then creates src/new.js; when a review comment arrives, replies whether
 * it included the file
 */
const agent = (kit: () => Kit) => ({
  reply: ({ prompt, toolResults }: { prompt: string; toolResults: string[] }) => {
    if (prompt.includes("这里改成 2"))
      return { text: `收到评论：${prompt.includes("src/math.js") ? "带文件" : "没带文件"}` }
    const file = path.join(kit().project, "src", "math.js")
    const steps = [
      { tool: "read", args: { filePath: file } },
      { tool: "write", args: { filePath: file, content: changed } },
      { tool: "write", args: { filePath: path.join(kit().project, "src", "new.js"), content: "export const x = 1\n" } },
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
  await hunk(kit, 1).getByRole("button", { name: "评论" }).click()
  await panel.getByRole("textbox", { name: "评论" }).fill("这里改成 2")
  await panel.getByRole("button", { name: "添加" }).click()
  await expect(panel.getByText(/1 条评论待发送/)).toBeVisible()
  await panel.getByRole("button", { name: "发给智能体" }).click()
  await expect(kit.text("收到评论：带文件")).toBeVisible({ timeout: 60_000 })
})

test("reviewing unstaged git changes: accepting a whole file stages it; another branch can be the base", async ({
  kit,
}) => {
  current = kit
  await prepare(kit)
  kit.git("add", ".")
  kit.git("commit", "--quiet", "-m", "math")
  kit.git("branch", "feature")

  const panel = kit.panel()
  // Before the conversation starts, only Git scopes appear
  await kit.page.getByRole("button", { name: "右侧面板" }).click()
  const turn = panel.getByRole("radio", { name: "本轮" })
  await expect(turn).toHaveCount(0)

  await kit.send("改一下 math.js")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })
  // The Review button on this turn's change card opens review in the side panel
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await panel.getByRole("radio", { name: "未暂存" }).click()
  const added = panel.getByRole("region", { name: "src/new.js" })
  await expect(added).toBeVisible()
  await added.getByRole("button", { name: "接受文件" }).click()
  await expect.poll(() => kit.git("diff", "--cached", "--name-only").trim()).toBe("src/new.js")
  await panel.getByRole("radio", { name: "已暂存" }).click()
  await expect(panel.getByRole("region", { name: "src/new.js" })).toBeVisible()

  // The branch scope is a dropdown: the current branch cannot be picked, another branch becomes the base
  await panel.getByRole("button", { name: /^比对分支/ }).click()
  await expect(kit.page.getByRole("option", { name: /^(main|master)\s/ })).toHaveAttribute("aria-disabled", "true")
  await kit.page.getByRole("option", { name: "feature" }).click()
  await expect(panel.getByRole("button", { name: /比对分支.*feature/ })).toBeVisible()
  await expect(panel.getByRole("region", { name: "src/math.js" })).toBeVisible()
})

test("many changed files start collapsed, and opening one loads its hunks", async ({ kit }) => {
  current = kit
  await prepare(kit)
  kit.git("add", ".")
  kit.git("commit", "--quiet", "-m", "math")
  for (const name of ["a", "b", "c", "d", "e", "f"]) await writeFile(path.join(kit.project, `${name}.txt`), `${name}\n`)
  await kit.send("改一下 math.js")
  await expect(kit.text("改好了")).toBeVisible({ timeout: 90_000 })

  const panel = kit.panel()
  await kit.page.getByRole("log").getByRole("button", { name: "审阅" }).click()
  await panel.getByRole("radio", { name: "未暂存" }).click()
  const math = panel.getByRole("region", { name: "src/math.js" })
  await expect(math).toBeVisible()
  await expect(math.getByRole("group")).toHaveCount(0)
  await math.getByRole("button", { name: "展开" }).click()
  await expect(math.getByRole("group")).toHaveCount(2)
})
