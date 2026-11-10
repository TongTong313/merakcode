import { test, expect } from "./fixture"
import { readFile } from "node:fs/promises"
import path from "node:path"

test.use({ git: true, claude: true, script: { reply: () => ({ tool: "say", args: { text: "成员消息已记录。" } }) } })

test("detects and probes Claude Code, then registers a profile and sends live input", async ({ kit }) => {
  await kit.settings(/^成员与档案$/)
  await expect(kit.text("2.1.0 (Claude Code fixture)")).toBeVisible()
  await kit.page.getByRole("button", { name: "复制 Worker", exact: true }).click()
  await kit.page.getByRole("textbox", { name: "档案名称", exact: true }).fill("Claude 检查员")
  await kit.page
    .getByRole("textbox", { name: "职责", exact: true })
    .fill("Check the requested task and report the result.")
  await kit.page.getByRole("combobox", { name: "产品", exact: true }).selectOption("claude-code")
  await expect(kit.page.getByRole("textbox", { name: "命令", exact: true })).not.toHaveValue("")
  await kit.page.getByRole("button", { name: "测试连通", exact: true }).click()
  await expect(kit.text("连通测试通过")).toBeVisible()
  await kit.page.getByRole("textbox", { name: "参数（每行一个）", exact: true }).fill("--hold")
  await kit.page.getByRole("button", { name: "保存档案", exact: true }).click()
  await expect(kit.page.getByRole("button", { name: "编辑 Claude 检查员", exact: true })).toBeVisible()
  await kit.page.keyboard.press("Escape")
  await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
  const dialog = kit.page.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "群名称" }).fill("外部成员")
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
  await kit.page.getByRole("button", { name: "添加成员", exact: true }).click()
  await dialog.getByRole("button", { name: "添加 Claude 检查员", exact: true }).click()
  await kit.page.keyboard.press("Escape")
  const member = () => kit.page.getByRole("group", { name: "成员 Claude 检查员", exact: true })
  await expect(member()).toBeVisible()
  await kit.send("@Claude 检查员 检查 README")
  await expect(member()).toContainText("忙碌")
  await kit.page.reload()
  await expect(member()).toContainText("忙碌")
  const inputs = async (): Promise<{ message: { content: string } }[]> => {
    const directory = kit
      .git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice(9).trim())
      .find((directory) => path.resolve(directory) !== path.resolve(kit.project))
    if (!directory) return []
    return readFile(path.join(directory, "inputs.json"), "utf8")
      .then((body) => JSON.parse(body))
      .catch(() => [])
  }
  await expect.poll(async () => (await inputs()).length).toBe(1)
  await member().getByRole("button", { name: "Claude 检查员", exact: true }).click()
  await member().getByRole("button", { name: "向 Claude 检查员 发消息", exact: true }).click()
  await kit.send("补充检查要求")
  await expect.poll(async () => (await inputs())[1]?.message.content).toContain("补充检查要求")
  await expect(member()).toContainText("空闲")
  await expect(kit.page.getByRole("log", { name: "群聊" })).toContainText("补充检查要求")
  await kit.page.reload()
  await expect(member()).toContainText("空闲")
})
