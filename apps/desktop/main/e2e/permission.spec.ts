import { access, readFile } from "node:fs/promises"
import path from "node:path"
import { test, expect, type Script } from "./fixture"

/** Each turn runs one node command, then replies with the turn number and the result */
const node =
  (code: string): Script =>
  ({ prompt, toolResults }) =>
    toolResults.length
      ? { text: `RAN ${prompt.match(/#(\d+)/)?.[1] ?? ""} ${toolResults.at(-1)?.trim()}` }
      : { tool: "bash", args: { command: `node -e "${code}"`, description: "run node" } }

test.describe("command approval", () => {
  test.use({ script: { reply: node("console.log(40+2)") } })

  test("ask mode asks before running a command; allowing it for the conversation stops asking", async ({ kit }) => {
    await kit.send("跑一下 #1")
    const card = kit.approval()
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card).toContainText("node")
    await card.getByText(/本对话允许 node 开头的命令/).click()
    await expect(kit.text(/RAN 1 42/)).toBeVisible({ timeout: 60_000 })

    await kit.send("再跑一下 #2")
    await expect(kit.text(/RAN 2 42/)).toBeVisible({ timeout: 60_000 })
    await expect(kit.approval()).toHaveCount(0)
  })

  test("a rejected command does not run and the model gets the rejection", async ({ kit }) => {
    await kit.send("跑一下 #3")
    const card = kit.approval()
    await expect(card).toBeVisible({ timeout: 60_000 })
    await card.getByText("拒绝", { exact: true }).click()
    await expect(kit.text(/RAN 3/)).toBeVisible({ timeout: 60_000 })
    await expect(kit.text(/RAN 3 42/)).toHaveCount(0)
  })
})

test.describe("auto mode", () => {
  test.use({ script: { reply: node("console.log(7*6)") } })

  test("ordinary commands run without approval in auto mode", async ({ kit }) => {
    await kit.mode(/自动|Auto/)
    await kit.send("跑一下 #4")
    await expect(kit.text(/RAN 4 42/)).toBeVisible({ timeout: 60_000 })
  })
})

test.describe("read-only mode", () => {
  test.use({
    script: {
      reply: ({ toolResults }) =>
        toolResults.length
          ? { text: `READONLY ${toolResults.at(-1)?.slice(0, 80)}` }
          : { tool: "write", args: { filePath: "blocked.txt", content: "should not exist\n" } },
    },
  })

  test("file writes are denied in read-only mode and no file is created", async ({ kit }) => {
    await kit.mode(/只读|Read-only/)
    await kit.send("写一个文件")
    await expect(kit.text(/READONLY/)).toBeVisible({ timeout: 60_000 })
    await expect(access(path.join(kit.project, "blocked.txt"))).rejects.toThrow()
    expect(await readFile(path.join(kit.project, "notes.txt"), "utf8")).toBe("hello from e2e\n")
  })
})
