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

  test("unisolated commands ask again after each once approval", async ({ kit }) => {
    await kit.send("跑一下 #1")
    const card = kit.approval()
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card).toContainText("node")
    await expect(card).toContainText(/当前操作未隔离|not isolated/i)
    await expect(card.getByText(/本对话允许|Allow.*conversation/)).toHaveCount(0)
    await card.getByRole("button", { name: /^允许这一次$|^Allow once$/ }).click()
    await expect(kit.text(/RAN 1 42/)).toBeVisible({ timeout: 60_000 })

    await kit.send("再跑一下 #2")
    await expect(kit.approval()).toBeVisible({ timeout: 60000 })
    await kit
      .approval()
      .getByRole("button", { name: /^允许这一次$|^Allow once$/ })
      .click()
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

test.describe("full takeover", () => {
  test.use({ script: { reply: node("console.log(7*6)") } })

  test("full takeover runs a command without safety approval", async ({ kit }) => {
    await kit.mode(/完全接管|Full takeover/)
    await kit.send("跑一下 #4")
    await expect(kit.text(/RAN 4 42/)).toBeVisible({ timeout: 60_000 })
  })
})

test.describe("draft task scope", () => {
  test.use({
    script: {
      reply: ({ toolResults }) =>
        toolResults.length
          ? { text: `READONLY ${toolResults.at(-1)?.slice(0, 80)}` }
          : { tool: "write", args: { filePath: "blocked.txt", content: "should not exist\n" } },
    },
  })

  test("full takeover preserves an explicit draft task scope", async ({ kit }) => {
    await kit.mode(/完全接管|Full takeover/)
    await kit.send("只出稿，不要修改项目。")
    await expect(kit.text(/READONLY/)).toBeVisible({ timeout: 60_000 })
    await expect(access(path.join(kit.project, "blocked.txt"))).rejects.toThrow()
    expect(await readFile(path.join(kit.project, "notes.txt"), "utf8")).toBe("hello from e2e\n")
  })
})
