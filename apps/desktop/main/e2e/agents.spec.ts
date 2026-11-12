import { test, expect } from "./fixture"
import { readFile } from "node:fs/promises"
import path from "node:path"

test.use({ git: true, claude: true, script: { reply: () => ({ tool: "say", args: { text: "成员消息已记录。" } }) } })

const inputs = async (kit: {
  git: (...args: string[]) => string
  project: string
}): Promise<{ message: { content: string } }[]> => {
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

test("detects Claude Code, adds it in one click, puts it in a group and sends live input", async ({ kit }) => {
  await kit.page.getByRole("button", { name: "新建智能体", exact: true }).click()
  await kit.page.keyboard.press("Escape")
  await expect(kit.page.getByRole("heading", { name: "智能体", exact: true })).toBeVisible()
  const detected = kit.page.getByRole("region", { name: "本机探测到的产品", exact: true })
  await expect(detected).toContainText("2.1.0 (Claude Code fixture)")
  await detected.getByRole("button", { name: "添加 Claude Code", exact: true }).click()
  await expect(detected.getByRole("button", { name: "已添加 Claude Code", exact: true })).toBeDisabled()
  await expect(detected.getByRole("button", { name: "添加 Claude Code", exact: true })).toHaveCount(0)
  const mine = kit.page.getByRole("region", { name: "我的智能体", exact: true })
  await expect(mine.locator("[data-agent]").filter({ hasText: "Claude Code" })).toContainText("claude-code")
  await expect(mine.locator("[data-agent]").filter({ hasText: "Claude Code" })).toContainText("默认模型")
  await mine.getByRole("button", { name: "编辑 Claude Code", exact: true }).click()
  const edit = kit.page.getByRole("dialog", { name: "编辑 Claude Code", exact: true })
  await edit.getByRole("button", { name: "下一步", exact: true }).click()
  await edit.getByRole("textbox", { name: "参数（每行一个）", exact: true }).fill("--hold")
  await edit.getByRole("button", { name: "下一步", exact: true }).click()
  await edit.getByRole("button", { name: "下一步", exact: true }).click()
  await edit.getByRole("button", { name: "保存", exact: true }).click()
  await expect(edit).toBeHidden()
  await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
  const dialog = kit.page.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "群名称" }).fill("外部成员")
  await dialog.getByRole("checkbox", { name: "选择 Claude Code", exact: true }).check()
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
  const member = () => kit.page.getByRole("group", { name: "成员 Claude-Code", exact: true })
  await expect(member()).toBeVisible()
  await kit.send("@Claude-Code 检查 README")
  await expect(member()).toContainText("忙碌")
  await kit.page.reload()
  await expect(member()).toContainText("忙碌")
  await expect.poll(async () => (await inputs(kit)).length).toBe(1)
  await member().getByRole("button", { name: "Claude-Code", exact: true }).click()
  await member().getByRole("button", { name: "向 Claude-Code 发消息", exact: true }).click()
  await kit.send("补充检查要求")
  await expect.poll(async () => (await inputs(kit))[1]?.message.content).toContain("补充检查要求")
  await expect(member()).toContainText("空闲")
  await expect(kit.page.getByRole("log", { name: "群聊" })).toContainText("补充检查要求")
  await kit.page.reload()
  await expect(member()).toContainText("空闲")
})

test("the wizard saves an external agent after a real connection check, and an edited secret field stays empty", async ({
  kit,
}) => {
  await kit.page.getByRole("button", { name: "新建智能体", exact: true }).click()
  const wizard = kit.page.getByRole("dialog", { name: "新建智能体", exact: true })
  await wizard.getByRole("radio", { name: "Claude Code", exact: true }).click()
  await wizard.getByRole("button", { name: "下一步", exact: true }).click()
  await expect(wizard.getByRole("textbox", { name: "命令", exact: true })).not.toHaveValue("")
  await wizard.getByRole("button", { name: "添加环境变量", exact: true }).click()
  await wizard.getByRole("textbox", { name: "变量名", exact: true }).fill("FIXTURE_TOKEN")
  await wizard.getByLabel("变量值", { exact: true }).fill("secret-value")
  await wizard.getByRole("button", { name: "测试连通", exact: true }).click()
  await expect(wizard).toContainText("连通测试通过")
  await wizard.getByRole("textbox", { name: "参数（每行一个）", exact: true }).fill("--hold")
  await wizard.getByRole("button", { name: "下一步", exact: true }).click()
  await wizard.getByRole("textbox", { name: "名称", exact: true }).fill("Claude 检查员")
  await wizard
    .getByRole("textbox", { name: "职责", exact: true })
    .fill("Check the requested task and report the result.")
  await wizard.getByRole("button", { name: "下一步", exact: true }).click()
  await wizard.getByRole("button", { name: "保存", exact: true }).click()
  await expect(wizard).toBeHidden()
  const mine = kit.page.getByRole("region", { name: "我的智能体", exact: true })
  await mine.getByRole("button", { name: "编辑 Claude 检查员", exact: true }).click()
  const edit = kit.page.getByRole("dialog", { name: "编辑 Claude 检查员", exact: true })
  await edit.getByRole("button", { name: "下一步", exact: true }).click()
  const value = edit.getByLabel("变量值", { exact: true })
  await expect(value).toHaveAttribute("type", "password")
  await expect(value).toHaveValue("")
  await expect(value).toHaveAttribute("placeholder", "已保存，留空不修改")
  await expect(edit).not.toContainText("secret-value")
})
