import { mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

// Takes the main pages of the real app in the light and the dark theme. The pictures land in the folder named by
// SCREENSHOT_DIR, or in the output of the test, so a run on any machine can put them next to the same pages of another
// build. The test fails when a page does not show or when the two themes look the same.
test.use({
  git: true,
  script: {
    reply: ({ tools }) =>
      tools.includes("say")
        ? { tool: "say", args: { text: "群消息已收到。" } }
        : { text: "你好，这是一个示例回复。\n\n- 第一项\n- 第二项" },
  },
})

const themes = ["light", "dark"] as const

test("the main pages show in the light and the dark theme", async ({ kit }, info) => {
  const directory = process.env.SCREENSHOT_DIR ?? info.outputPath("screenshots")
  await mkdir(directory, { recursive: true })
  const pictures = new Map<string, string>()
  const shoot = async (name: string) => {
    for (const theme of themes) {
      await kit.page.emulateMedia({ colorScheme: theme })
      // Let the theme reach the editor, the terminal and the transitions
      await kit.page.waitForTimeout(250)
      const file = path.join(directory, `${name}-${theme}.png`)
      await kit.page.screenshot({ path: file })
      pictures.set(`${name}-${theme}`, file)
    }
  }
  const origin = () => new URL(kit.page.url()).origin
  const visit = (route: string) => kit.page.goto(`${origin()}${route}`)

  await kit.send("你好")
  await expect(kit.text("这是一个示例回复")).toBeVisible()
  await shoot("conversation")

  await kit.openPanel("git")
  await expect(kit.panel()).toBeVisible()
  await shoot("conversation-panel")

  await visit("/")
  await expect(kit.page.getByRole("link", { name: "首页", exact: true })).toBeVisible()
  await shoot("home")

  await visit("/agents")
  await expect(kit.page.getByRole("region", { name: "我的智能体", exact: true })).toBeVisible()
  await shoot("agents")

  await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
  const dialog = kit.page.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "群名称" }).fill("截图协作")
  await shoot("group-create")
  await dialog.getByRole("checkbox", { name: "选择 MerakCode", exact: true }).check()
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
  await kit.send("请开始")
  await expect(kit.text("群消息已收到。")).toBeVisible()
  await shoot("group")

  await kit.page.getByRole("button", { name: "新建任务", exact: true }).click()
  await dialog.getByRole("textbox", { name: "标题", exact: true }).fill("检查指南")
  await dialog.getByRole("textbox", { name: "描述", exact: true }).fill("检查所有示例。")
  await dialog.getByRole("textbox", { name: "验收标准", exact: true }).fill("示例完整\n链接可用")
  await dialog.getByRole("button", { name: "创建任务", exact: true }).click()
  await expect(kit.page.getByRole("heading", { name: "检查指南", exact: true })).toBeVisible()
  await shoot("task")

  await visit("/tasks")
  await expect(kit.page.getByText("检查指南").first()).toBeVisible()
  await shoot("board")

  for (const section of [/^(通用|General)$/, /^(模型与供应商|Models & providers)$/, /^(后台引擎|Background engine)$/]) {
    await kit.settings(section)
    await shoot(
      `settings-${section.source
        .replace(/[^a-zA-Z]+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase()}`,
    )
    await kit.page.keyboard.press("Escape")
  }

  for (const [key, file] of pictures) {
    expect((await stat(file)).size, `${key} is empty`).toBeGreaterThan(5_000)
  }
  // A page that does not follow the theme would give the same picture twice
  for (const key of new Set([...pictures.keys()].map((value) => value.replace(/-(light|dark)$/, "")))) {
    const [light, dark] = await Promise.all(themes.map((theme) => stat(pictures.get(`${key}-${theme}`)!)))
    expect(light!.size, `${key} looks the same in both themes`).not.toBe(dark!.size)
  }
})
