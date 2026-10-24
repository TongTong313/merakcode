import { mkdirSync, writeFileSync } from "node:fs"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Page } from "@playwright/test"
import { test, expect } from "./fixture"

/** Stand-in for a coding CLI: reads the prompt on stdin and prints only its final reply */
const SEAT = [
  `let prompt = ""`,
  `for await (const chunk of process.stdin) prompt += chunk`,
  `process.stdout.write(prompt.includes("做登录") ? ${JSON.stringify("登录入口已改到 src/auth/login.ts\n")} : "?")`,
].join("\n")
const fake = { command: process.execPath, title: "Fake CLI", args: ["--input-type=module", "-e", SEAT] }

const LOADER = new URL("../../../../script/node/register.mjs", import.meta.url).href

/** A product whose adapter is fake-member.ts, with this scenario */
const member = (title: string, scenario: object) => ({
  title,
  adapter: "member",
  command: process.execPath,
  args: [
    "--import",
    LOADER,
    "--disable-warning=ExperimentalWarning",
    path.join(import.meta.dirname, "fake-member.ts"),
    JSON.stringify(scenario),
  ],
})

/** Creates a group with one member through the new-group dialog */
async function createGroup(page: Page, member: { product: string; name: string; role?: string; duty?: string }) {
  await page.getByRole("button", { name: "新建协作群" }).click()
  const dialog = page.getByRole("dialog", { name: "新建协作群" })
  await dialog.getByRole("button", { name: "添加成员" }).click()
  await dialog.getByRole("button", { name: /^产品/ }).click()
  await page.getByRole("option", { name: member.product }).click()
  await dialog.getByRole("textbox", { name: "姓名" }).fill(member.name)
  if (member.role) await dialog.getByRole("textbox", { name: "角色" }).fill(member.role)
  if (member.duty) await dialog.getByRole("textbox", { name: "职责" }).fill(member.duty)
  await dialog.getByRole("button", { name: "加入" }).click()
  await dialog.getByRole("button", { name: "创建" }).click()
}

test.describe("group chat", () => {
  test.use({
    config: {
      collaboration: {
        products: {
          fake,
          missing: { command: "merak-e2e-missing-cli", title: "Missing CLI" },
        },
      },
    },
    script: {
      reply: ({ toolResults }) =>
        toolResults.length === 0
          ? { tool: "delegate", args: { seat: "小红", task: "做登录", paths: ["src/auth/**"] } }
          : { text: "都做完了" },
    },
  })

  test("members stay in the member column and the leader's delegation reads as a chat", async ({ kit }) => {
    const { page } = kit
    await createGroup(page, { product: "Fake CLI", name: "小红", role: "产品经理" })

    const members = page.getByRole("complementary", { name: "群成员" })
    await expect(members.getByRole("button", { name: /小主/ })).toBeVisible()
    await expect(members.getByRole("button", { name: /小红/ })).toBeVisible()
    const log = page.getByRole("log", { name: "消息记录" })
    await expect(log.getByText("你邀请 小红 加入了群聊")).toBeVisible()

    await kit.send("@小红 做登录")
    const xiaohong = log.getByRole("article", { name: "小红" })
    await expect(xiaohong).toContainText("登录入口已改到 src/auth/login.ts", { timeout: 60_000 })
    await expect(xiaohong).toContainText("Fake CLI · 产品经理")
    await expect(log.getByRole("article", { name: "小主" })).toContainText("都做完了")
    const order = await log.getByRole("article").evaluateAll((items) => items.map((item) => item.ariaLabel))
    expect(order).toEqual(["你说", "小红", "小主"])

    const mine = await log.getByText("@小红 做登录").boundingBox()
    const theirs = await xiaohong.getByText("登录入口已改到 src/auth/login.ts").boundingBox()
    expect(mine!.x).toBeGreaterThan(theirs!.x)
    expect(await log.getByRole("textbox").count()).toBe(0)
    expect(await log.getByRole("combobox").count()).toBe(0)

    // The count shows once, on the top bar; the todo lines up with the messages and the composer
    await expect(page.getByRole("button", { name: "2 位成员" })).toHaveText("2")
    const input = page.getByRole("textbox", { name: "消息" }).filter({ visible: true }).first()
    await expect(input).toHaveAttribute("placeholder", "发给群里，可以用 @ 点名成员")
    // Wide enough that the messages are a centred column narrower than the chat area
    await page.setViewportSize({ width: 1800, height: 900 })
    const todo = await page.getByRole("button", { name: /待办/ }).boundingBox()
    const composer = await input.boundingBox()
    expect(Math.abs(todo!.x - composer!.x)).toBeLessThan(24)
  })
})

test.describe("group members", () => {
  test.use({
    config: {
      collaboration: {
        products: {
          fake,
          missing: { command: "merak-e2e-missing-cli", title: "Missing CLI" },
        },
      },
    },
  })

  test("members are added, renamed and removed in the member column, and the chat notes each change", async ({
    kit,
  }) => {
    const { page } = kit
    await page.getByRole("button", { name: "新建协作群" }).click()
    const dialog = page.getByRole("dialog", { name: "新建协作群" })
    await dialog.getByRole("textbox", { name: "群名称" }).fill("登录支付")
    await dialog.getByRole("button", { name: "创建" }).click()
    await expect(page.getByText("在右侧添加 Claude Code、Codex 等成员，或直接交代任务")).toBeVisible()

    const members = page.getByRole("complementary", { name: "群成员" })
    // @ only names members; adding one is the member column's
    await page.getByRole("textbox", { name: "消息" }).filter({ visible: true }).first().pressSequentially("@")
    await expect(page.getByRole("option", { name: /添加成员/ })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await members.getByRole("button", { name: "添加成员" }).click()
    await members.getByRole("button", { name: /^产品/ }).click()
    await page.getByRole("option", { name: /Fake CLI/ }).click()
    await members.getByRole("textbox", { name: "姓名" }).fill("小红")
    await members.getByRole("textbox", { name: "职责" }).fill("负责登录，不改支付")
    await members.getByRole("button", { name: "加入" }).click()
    const log = page.getByRole("log", { name: "消息记录" })
    await expect(log.getByText("你邀请 小红 加入了群聊")).toBeVisible()
    await expect(page.getByRole("button", { name: "2 位成员" })).toBeVisible()
    // The sidebar row is marked as a group and lists its members under the title
    await expect(
      page.getByRole("navigation", { name: "对话" }).getByRole("link", { name: /^登录支付 协作 小主、小红/ }),
    ).toBeVisible()

    await members.getByRole("button", { name: /小红/ }).click()
    await members.getByRole("textbox", { name: "姓名" }).fill("小芳")
    await members.getByRole("button", { name: "保存" }).click()
    await expect(log.getByText("小红 改名为 小芳")).toBeVisible()

    await members.getByRole("button", { name: "添加成员" }).click()
    await members.getByRole("button", { name: /^产品/ }).click()
    await expect(page.getByRole("option", { name: /Missing CLI/ })).toHaveAttribute("aria-disabled", "true")
    await page.keyboard.press("Escape")
    await members.getByRole("button", { name: "取消" }).click()

    await members.getByRole("button", { name: /小芳/ }).click()
    await members.getByRole("button", { name: "移出" }).click()
    await page.getByRole("dialog", { name: "移出 小芳？" }).getByRole("button", { name: "移出" }).click()
    await expect(log.getByText("小芳 已被移出群聊")).toBeVisible()
    await expect(page.getByRole("button", { name: "1 位成员" })).toBeVisible()
  })
})

test.describe("a MerakCode member", () => {
  test.use({
    script: {
      reply: ({ prompt, toolResults }) => {
        if (prompt.startsWith("You are 小明 (MerakCode)"))
          return toolResults.length === 0
            ? { tool: "write", args: { filePath: "refund.md", content: "退款边界\n" } }
            : { text: "退款边界写在 refund.md" }
        return toolResults.length === 0
          ? { tool: "delegate", args: { seat: "小明", task: "写退款边界" } }
          : { text: "小明写好了" }
      },
    },
  })

  test("works in a child session of its own, which the chat links to", async ({ kit }) => {
    const { page } = kit
    await createGroup(page, { product: "MerakCode", name: "小明", duty: "负责看退款边界" })

    await kit.send("@小明 写退款边界")
    const log = page.getByRole("log", { name: "消息记录" })
    const xiaoming = log.getByRole("article", { name: "小明" })
    await expect(xiaoming).toContainText("退款边界写在 refund.md", { timeout: 60_000 })
    await expect(log.getByRole("article", { name: "小主" })).toContainText("小明写好了")
    expect(await readFile(path.join(kit.project, "refund.md"), "utf8")).toBe("退款边界\n")

    await xiaoming.getByRole("button", { name: "查看过程" }).click()
    await expect(page.getByRole("button", { name: "返回主对话" })).toBeVisible()
  })
})

test.describe("stopping a MerakCode member", () => {
  test.use({
    script: {
      reply: async ({ prompt, toolResults }) => {
        if (prompt.startsWith("You are 小明 (MerakCode)")) {
          if (toolResults.length) return { text: "写完了" }
          // A slow step: by the time it answers, the user has stopped the group
          await new Promise((resolve) => setTimeout(resolve, 1_500))
          return { tool: "write", args: { filePath: "late.md", content: "late\n" } }
        }
        return toolResults.length === 0 ? { tool: "delegate", args: { seat: "小明", task: "慢慢写" } } : { text: "好" }
      },
    },
  })

  test("stopping the group stops the member's child session and cancels its todo item", async ({ kit }) => {
    const { page } = kit
    await createGroup(page, { product: "MerakCode", name: "小明" })
    await kit.send("@小明 慢慢写")
    const xiaoming = page.getByRole("log", { name: "消息记录" }).getByRole("article", { name: "小明" })
    await expect(xiaoming).toContainText("已运行")
    await expect(page.getByRole("button", { name: /待办 0\/1/ })).toBeVisible()

    await page.getByRole("button", { name: "停止" }).click()
    await expect(xiaoming).toContainText("已停止")
    await expect(xiaoming).toContainText("MerakCode")
    await expect(page.getByRole("button", { name: /待办/ })).toHaveCount(0)
    await page.waitForTimeout(2_500)
    await expect(access(path.join(kit.project, "late.md"))).rejects.toThrow()
  })
})

test.describe("a member at work", () => {
  // It reports a step, then holds until the test lets it finish
  const gate = path.join(os.tmpdir(), `merak-e2e-gate-${process.pid}`)
  test.use({
    config: {
      collaboration: {
        products: {
          steps: member("Step CLI", { steps: [{ tool: "Bash", detail: "npm test", gate }], reply: "测试都过了" }),
        },
      },
    },
    script: {
      reply: ({ toolResults }) =>
        toolResults.length === 0 ? { tool: "delegate", args: { seat: "小红", task: "跑测试" } } : { text: "好" },
    },
  })

  test("shows what the member is doing while it works, and keeps the steps after it is done", async ({ kit }) => {
    const { page } = kit
    await rm(gate, { force: true })
    await createGroup(page, { product: "Step CLI", name: "小红" })
    await kit.send("@小红 跑测试")
    const xiaohong = page.getByRole("log", { name: "消息记录" }).getByRole("article", { name: "小红" })
    await expect(xiaohong).toContainText("已运行")
    await expect(xiaohong).toContainText("Bash npm test")
    await writeFile(gate, "")
    await expect(xiaohong).toContainText("测试都过了")
    await expect(xiaohong.getByRole("button", { name: "1 步" })).toBeVisible()
    await rm(gate, { force: true })
  })
})

test.describe("the entry to a team", () => {
  test("Ctrl+G, the sidebar and the palette all open the new-team dialog, which says what a team is", async ({
    kit,
  }) => {
    const { page } = kit
    const dialog = page.getByRole("dialog", { name: "新建协作群" })
    const entry = page.getByRole("button", { name: /^新建协作群/ })
    await expect(entry).toContainText("Ctrl G")

    await page.keyboard.press("Control+G")
    await expect(dialog).toContainText("让 MerakCode 当群主，拉上 Claude Code、Codex 等一起干活")
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)

    await entry.click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press("Escape")

    await page.keyboard.press("Control+K")
    await page.keyboard.type("协作")
    await page.getByRole("option", { name: /新建协作群/ }).click()
    await expect(dialog).toBeVisible()
  })
})

test.describe("a backend restart in the middle of a member's work", () => {
  test.use({
    config: {
      collaboration: {
        products: {
          // Its gate is never opened: it works until it is stopped
          slow: member("Slow CLI", {
            steps: [{ tool: "Bash", detail: "think", gate: path.join(os.tmpdir(), `merak-e2e-never-${process.pid}`) }],
          }),
        },
      },
    },
    script: {
      reply: ({ toolResults }) =>
        toolResults.length === 0 ? { tool: "delegate", args: { seat: "小明", task: "慢慢想" } } : { text: "好" },
    },
  })

  test("leaves the conversation idle and the member stopped, instead of running forever", async ({ kit }) => {
    const { page } = kit
    await createGroup(page, { product: "Slow CLI", name: "小明" })
    await kit.send("@小明 慢慢想")
    const xiaoming = page.getByRole("log", { name: "消息记录" }).getByRole("article", { name: "小明" })
    await expect(xiaoming).toContainText("Bash think")
    await page.evaluate(() =>
      (
        window as unknown as { __MERAKCODE_DESKTOP__: { restartBackend: () => void } }
      ).__MERAKCODE_DESKTOP__.restartBackend(),
    )
    // The engine went away mid-turn: the chat says so instead of running forever
    await expect(xiaoming).toContainText("已停止", { timeout: 30_000 })
    await expect(xiaoming).not.toContainText("已运行", { timeout: 30_000 })
    const row = page.getByRole("navigation", { name: "对话" }).getByRole("link").first()
    await expect(row).not.toContainText("运行中")
    await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0)
  })
})

test.describe("copying a group", () => {
  test.use({ config: { collaboration: { products: { fake } } } })

  test("a group from another project is copied with its members' names, roles and duties", async ({ kit }) => {
    const { page } = kit
    const other = path.join(kit.root, "other")
    await mkdir(other, { recursive: true })
    const status = await page.evaluate(
      async ({ directory }) =>
        (
          await fetch(`/collaboration?directory=${encodeURIComponent(directory)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "登录小组",
              leader: { name: "老大", duty: "带队" },
              seats: [{ name: "小红", role: "产品经理", duty: "负责登录，不改支付", product: "fake" }],
            }),
          })
        ).status,
      { directory: other },
    )
    expect(status).toBe(200)

    await page.getByRole("button", { name: "新建协作群" }).click()
    const dialog = page.getByRole("dialog", { name: "新建协作群" })
    await dialog.getByRole("button", { name: /^从已有群复制/ }).click()
    await page.getByRole("option", { name: /登录小组/ }).click()
    await expect(dialog.getByRole("textbox", { name: "群名称" })).toHaveValue("登录小组")
    await dialog.getByRole("button", { name: "创建" }).click()

    const members = page.getByRole("complementary", { name: "群成员" })
    await expect(members.getByRole("button", { name: /老大/ })).toBeVisible()
    await expect(members.getByRole("button", { name: /小红/ })).toContainText("Fake CLI · 产品经理")
    await members.getByRole("button", { name: /小红/ }).click()
    await expect(members.getByRole("textbox", { name: "职责" })).toHaveValue("负责登录，不改支付")
    // The copy is a new group of this project, not the old conversation
    await expect(page.getByRole("log", { name: "消息记录" }).getByText("你邀请 小红 加入了群聊")).toBeVisible()
    await expect(
      page.getByRole("navigation", { name: "对话" }).getByRole("link", { name: /^登录小组 协作 老大、小红/ }),
    ).toBeVisible()
  })
})

test.describe("collaboration settings", () => {
  test.use({
    config: {
      collaboration: {
        products: {
          fake,
          missing: { command: "merak-e2e-missing-cli", title: "Missing CLI" },
        },
      },
    },
  })

  test("the picker links to settings, where products are added and turned off for the next group", async ({ kit }) => {
    const { page } = kit
    const global = path.join(kit.root, "merakcode.json")
    await page.getByRole("button", { name: "新建协作群" }).click()
    const dialog = page.getByRole("dialog", { name: "新建协作群" })
    await dialog.getByRole("button", { name: "添加成员" }).click()
    await dialog.getByRole("button", { name: "部分产品不可用 · 查看原因" }).click()

    const panel = page.getByRole("region", { name: "协作群" })
    await expect(panel).toContainText("不可用 · merak-e2e-missing-cli 未安装")
    await panel.getByRole("button", { name: "添加产品" }).click()
    await panel.getByRole("textbox", { name: "ID", exact: true }).fill("echo")
    await panel.getByRole("textbox", { name: "名称" }).fill("Echo CLI")
    await panel.getByRole("textbox", { name: "命令" }).fill(process.execPath)
    await panel.getByRole("button", { name: "保存" }).click()
    await expect(panel).toContainText("Echo CLI")
    await panel.getByRole("switch", { name: "启用 Fake CLI" }).click()
    await expect(panel.getByRole("switch", { name: "启用 Fake CLI" })).toHaveAttribute("aria-checked", "false")
    await expect
      .poll(async () => JSON.parse(await readFile(global, "utf8")).collaboration.products)
      .toMatchObject({ echo: { command: process.execPath, title: "Echo CLI" }, fake: { enabled: false } })

    await page.getByRole("button", { name: "返回" }).click()
    await page.getByRole("button", { name: "新建协作群" }).click()
    await dialog.getByRole("button", { name: "添加成员" }).click()
    await dialog.getByRole("button", { name: /^产品/ }).click()
    await expect(page.getByRole("option", { name: /Echo CLI/ })).toBeVisible()
    await expect(page.getByRole("option", { name: /Fake CLI/ })).toHaveCount(0)
  })

  test("a product added in settings from a group's member column is offered there on return", async ({ kit }) => {
    const { page } = kit
    await createGroup(page, { product: "Fake CLI", name: "小红" })
    const members = page.getByRole("complementary", { name: "群成员" })
    await members.getByRole("button", { name: "添加成员" }).click()
    await members.getByRole("button", { name: "部分产品不可用 · 查看原因" }).click()

    const panel = page.getByRole("region", { name: "协作群" })
    await panel.getByRole("button", { name: "添加产品" }).click()
    await panel.getByRole("textbox", { name: "ID", exact: true }).fill("echo")
    await panel.getByRole("textbox", { name: "名称" }).fill("Echo CLI")
    await panel.getByRole("textbox", { name: "命令" }).fill(process.execPath)
    await panel.getByRole("button", { name: "保存" }).click()
    await expect(panel).toContainText("Echo CLI")
    await page.getByRole("button", { name: "返回" }).click()

    await members.getByRole("button", { name: /^产品/ }).click()
    await expect(page.getByRole("option", { name: /Echo CLI/ })).toBeVisible()
  })
})

/**
 * A fake Claude Code (fake-claude.ts) on disk, wanting to use tools. It is written when this file loads, so
 * the config can name it before the app starts: a config written later would leave the real claude to be run.
 */
function fakeClaude(name: string, tools: unknown[]) {
  const dir = path.join(os.tmpdir(), "merakcode-e2e-claude", name)
  mkdirSync(dir, { recursive: true })
  const script = path.join(import.meta.dirname, "fake-claude.ts")
  const run = `"${process.execPath}" --import ${LOADER} --disable-warning=ExperimentalWarning "${script}"`
  // The tools go in a file: quotes and Chinese text do not survive a .cmd set line
  const file = path.join(dir, "tools.json")
  writeFileSync(file, JSON.stringify(tools))
  const command = path.join(dir, process.platform === "win32" ? "claude.cmd" : "claude")
  writeFileSync(
    command,
    process.platform === "win32"
      ? `@set "CLAUDE_FIXTURE_FILE=${file}"\r\n@${run} %*\r\n`
      : `#!/bin/sh\nexport CLAUDE_FIXTURE_FILE="${file}"\nexec ${run} "$@"\n`,
    { mode: 0o755 },
  )
  return command
}

const delegateOnce = {
  reply: ({ toolResults }: { toolResults: string[] }) =>
    toolResults.length === 0 ? { tool: "delegate", args: { seat: "小明", task: "查资料" } } : { text: "好了" },
}

test.describe("a Claude Code member that needs approval", () => {
  const command = fakeClaude("approval", [{ name: "WebFetch", input: { url: "https://example.com" } }])
  test.use({ config: { collaboration: { products: { claude: { command } } } }, script: delegateOnce })

  test("its request to reach a website is asked in the approval bar, named after it, and allowing it lets it go on", async ({
    kit,
  }) => {
    const { page } = kit
    await createGroup(page, { product: "Claude Code", name: "小明" })
    await kit.send("@小明 查资料")
    const card = kit.approval()
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card).toContainText("小明 · Claude Code 请求")
    await expect(card).toContainText("example.com")
    const xiaoming = page.getByRole("log", { name: "消息记录" }).getByRole("article", { name: "小明" })
    await expect(xiaoming).toContainText("等待你批准")
    await card.getByText("允许", { exact: true }).click()
    await expect(xiaoming).toContainText("WebFetch allowed", { timeout: 60_000 })
  })
})

test.describe("a Claude Code member that asks a question", () => {
  const command = fakeClaude("question", [
    {
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "用哪个数据库？",
            header: "数据库",
            multiSelect: false,
            options: [
              { label: "PostgreSQL", description: "关系型" },
              { label: "SQLite", description: "嵌入式" },
            ],
          },
        ],
      },
    },
  ])
  test.use({ config: { collaboration: { products: { claude: { command } } } }, script: delegateOnce })

  test("its question opens MerakCode's question, named after it, and the answer reaches it", async ({ kit }) => {
    const { page } = kit
    await createGroup(page, { product: "Claude Code", name: "小明" })
    await kit.send("@小明 查资料")
    const dialog = page.getByRole("region", { name: "提问" })
    await expect(dialog).toBeVisible({ timeout: 60_000 })
    await expect(dialog).toContainText("小明 · Claude Code 提问")
    await dialog.getByRole("button", { name: /SQLite/ }).click()
    const xiaoming = page.getByRole("log", { name: "消息记录" }).getByRole("article", { name: "小明" })
    await expect(xiaoming).toContainText('"用哪个数据库？":"SQLite"', { timeout: 60_000 })
  })
})

test.describe("a Claude Code member allowed a website for the conversation", () => {
  const command = fakeClaude("conversation", [
    { name: "WebFetch", input: { url: "https://example.com/a" } },
    { name: "WebFetch", input: { url: "https://example.com/b" } },
  ])
  test.use({ config: { collaboration: { products: { claude: { command } } } }, script: delegateOnce })

  test("its next page of that website is not asked about", async ({ kit }) => {
    const { page } = kit
    await createGroup(page, { product: "Claude Code", name: "小明" })
    await kit.send("@小明 查资料")
    const card = kit.approval()
    await expect(card).toBeVisible({ timeout: 60_000 })
    await card.getByText(/本对话允许 example\.com/).click()
    // A second approval would wait with no one to answer it: the reply means it was not asked
    const xiaoming = page.getByRole("log", { name: "消息记录" }).getByRole("article", { name: "小明" })
    await expect(xiaoming).toContainText('WebFetch allowed {"url":"https://example.com/b"}', { timeout: 60_000 })
  })
})

test.describe("a Claude Code member refused with a reason", () => {
  const command = fakeClaude("reason", [{ name: "WebFetch", input: { url: "https://example.com/a" } }])
  test.use({ config: { collaboration: { products: { claude: { command } } } }, script: delegateOnce })

  test("gets the reason the user wrote", async ({ kit }) => {
    const { page } = kit
    await createGroup(page, { product: "Claude Code", name: "小明" })
    await kit.send("@小明 查资料")
    const card = kit.approval()
    await expect(card).toBeVisible({ timeout: 60_000 })
    await card.getByText("拒绝并说明…").click()
    await card.getByRole("textbox", { name: "拒绝原因" }).fill("先用本地资料")
    await card.getByRole("button", { name: "拒绝", exact: true }).click()
    const xiaoming = page.getByRole("log", { name: "消息记录" }).getByRole("article", { name: "小明" })
    await expect(xiaoming).toContainText(/WebFetch denied: .*先用本地资料/, { timeout: 60_000 })
  })
})

test.describe("a Claude Code member always allowed a website", () => {
  const command = fakeClaude("always", [{ name: "WebFetch", input: { url: "https://example.com/a" } }])
  test.use({ config: { collaboration: { products: { claude: { command } } } }, script: delegateOnce })

  test("has the rule saved to the project", async ({ kit }) => {
    const { page } = kit
    await createGroup(page, { product: "Claude Code", name: "小明" })
    await kit.send("@小明 查资料")
    const card = kit.approval()
    await expect(card).toBeVisible({ timeout: 60_000 })
    await card.getByText("总是允许", { exact: true }).click()
    const xiaoming = page.getByRole("log", { name: "消息记录" }).getByRole("article", { name: "小明" })
    await expect(xiaoming).toContainText("WebFetch allowed", { timeout: 60_000 })
    const config = path.join(kit.project, ".merakcode", "merakcode.json")
    await expect.poll(async () => readFile(config, "utf8").catch(() => "")).toContain("example.com")
  })
})
