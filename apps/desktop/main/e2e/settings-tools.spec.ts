import { readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { test, expect } from "./fixture"

// Managing the agent's tools and knowledge in settings: MCP, skills, plugins, rules, memory

/** Parses JSONC after stripping whole-line comments */
const json = async (file: string) =>
  JSON.parse((await readFile(file, "utf8").catch(() => "{}")).replace(/^\s*\/\/.*$/gm, "")) as Record<string, any>

/** Minimal stdio MCP server with one ping tool */
const MCP_SERVER = `
import { createInterface } from "node:readline"
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n")
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  if (message.method === "initialize")
    return reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "e2e", version: "1.0.0" },
    })
  if (message.method === "tools/list")
    return reply(message.id, {
      tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
    })
  if (message.method === "ping") return reply(message.id, {})
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } }) + "\\n")
})
`

test("MCP: a local server shows its tool count once connected; deleting removes it from config", async ({ kit }) => {
  const server = path.join(kit.root, "mcp-server.mjs")
  await writeFile(server, MCP_SERVER)
  const config = path.join(kit.root, "merakcode.json")
  await kit.settings(/^MCP 服务器$/)
  const panel = kit.page.getByRole("region", { name: "MCP 服务器" })
  await panel.getByRole("textbox", { name: "名称" }).fill("e2e")
  await panel.getByRole("textbox", { name: "命令或网址" }).fill(`node "${server}"`)
  await panel.getByRole("button", { name: "添加" }).click()
  await expect(panel.getByText(/1 个工具/)).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await json(config)).mcp?.e2e?.command).toEqual(["node", server])

  await panel.getByRole("button", { name: "删除 e2e" }).click()
  await expect(panel.getByText("还没有 MCP 服务器")).toBeVisible()
  await expect.poll(async () => (await json(config)).mcp?.e2e).toBeUndefined()
})

test("skills: installs a skill from a URL into the project; uninstalling deletes its directory", async ({ kit }) => {
  const files: Record<string, string> = {
    "/skills/index.json": JSON.stringify({
      skills: [{ name: "e2e-skill", description: "E2E 技能", files: ["SKILL.md"] }],
    }),
    "/skills/e2e-skill/SKILL.md": "---\nname: e2e-skill\ndescription: E2E 技能\n---\n\nE2E_SKILL_BODY\n",
  }
  const server = createServer((request, response) => {
    const body = files[request.url ?? ""]
    response.writeHead(body ? 200 : 404)
    response.end(body ?? "")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const skill = path.join(kit.project, ".merakcode", "skills", "e2e-skill", "SKILL.md")
  try {
    await kit.settings(/^技能$/)
    const panel = kit.page.getByRole("region", { name: "技能" })
    await panel.getByRole("textbox", { name: "技能来源" }).fill(`http://127.0.0.1:${port}/skills`)
    await panel.getByRole("button", { name: "查找" }).click()
    await panel.getByRole("button", { name: "安装 e2e-skill" }).click()
    await expect.poll(() => readFile(skill, "utf8").catch(() => "")).toContain("E2E_SKILL_BODY")
    await expect(panel.getByText("E2E 技能").first()).toBeVisible()

    await panel.getByRole("button", { name: "卸载 e2e-skill" }).click()
    await kit.page.getByRole("dialog").getByRole("button", { name: "卸载" }).click()
    await expect(panel.getByRole("button", { name: "卸载 e2e-skill" })).toHaveCount(0)
    await expect.poll(() => readFile(skill, "utf8").catch(() => "")).toBe("")
  } finally {
    server.close()
  }
})

test.describe("rules", () => {
  test.use({
    script: { reply: ({ system }) => ({ text: system.includes("E2E_RULE_TEXT") ? "RULE_SEEN" : "RULE_MISSING" }) },
  })

  test("personal rules are saved to global config and sent with the next message; edits and deletes too", async ({
    kit,
  }) => {
    const config = path.join(kit.root, "merakcode.json")
    const rules = async () => (await json(config)).rules?.user ?? []
    const panel = kit.page.getByRole("region", { name: "规则" })
    await kit.settings(/^规则$/)
    await panel.getByRole("textbox", { name: "新的个人规则" }).fill("E2E_RULE_TEXT 回答要简短")
    await panel.getByRole("button", { name: "添加" }).click()
    await expect.poll(rules).toEqual(["E2E_RULE_TEXT 回答要简短"])

    await kit.page.keyboard.press("Escape")
    await kit.send("你好")
    await expect(kit.text("RULE_SEEN")).toBeVisible()

    await kit.settings(/^规则$/)
    await panel.getByRole("button", { name: "编辑 个人规则 1" }).click()
    await panel.getByRole("textbox", { name: "个人规则 1" }).fill("E2E_RULE_EDITED")
    await panel.getByRole("button", { name: "保存" }).click()
    await expect.poll(rules).toEqual(["E2E_RULE_EDITED"])

    await panel.getByRole("button", { name: "删除 个人规则 1" }).click()
    await expect.poll(rules).toEqual([])
  })

  test("project rules: creates a rule file, saves edits to disk, deleting removes the file", async ({ kit }) => {
    const file = path.join(kit.project, ".merakcode", "rules", "e2e.mdc")
    const read = () => readFile(file, "utf8").catch(() => "")
    const panel = kit.page.getByRole("region", { name: "规则" })
    await kit.settings(/^规则$/)
    await panel.getByRole("textbox", { name: "新规则文件名" }).fill("e2e")
    await panel.getByRole("button", { name: "新建" }).click()
    await expect.poll(read).not.toBe("")

    // A new rule file opens straight in the editor
    await panel.getByRole("textbox", { name: "e2e.mdc" }).fill("---\nalwaysApply: true\n---\n\nE2E_PROJECT_RULE\n")
    await panel.getByRole("button", { name: "保存" }).click()
    await expect.poll(read).toContain("E2E_PROJECT_RULE")

    await panel.getByRole("button", { name: "删除 e2e.mdc" }).click()
    await expect.poll(read).toBe("")
  })
})

test.describe("memory", () => {
  // The agent saves a note with its remember tool; memories are notes of the project, not files
  test.use({
    script: {
      reply: ({ toolResults }) =>
        toolResults.length
          ? { text: "记住了" }
          : {
              tool: "remember",
              args: { kind: "preference", text: "这个项目用 pnpm 装依赖\n用 pnpm，不要用 npm。E2E_MEMORY_BODY" },
            },
    },
  })

  test("lists, opens and deletes project memories; auto-remember can be enabled", async ({ kit }) => {
    const config = path.join(kit.root, "merakcode.json")
    const panel = kit.page.getByRole("region", { name: "记忆" })
    await kit.settings(/^记忆$/)
    await expect(panel.getByText("还没有记忆")).toBeVisible()
    await kit.page.keyboard.press("Escape")
    await kit.mode(/全面接管|Full takeover/)
    await kit.send("记一下")
    await expect(kit.text("记住了")).toBeVisible()

    await kit.settings(/^记忆$/)
    await expect(panel.getByText("这个项目用 pnpm 装依赖")).toBeVisible()
    await panel.getByRole("button", { name: "查看 这个项目用 pnpm 装依赖" }).click()
    await expect(panel.getByText(/E2E_MEMORY_BODY/)).toBeVisible()
    await panel.getByRole("button", { name: "删除 这个项目用 pnpm 装依赖" }).click()
    await expect(panel.getByText("还没有记忆")).toBeVisible()

    // Automatic remembering is off until it is turned on
    const auto = panel.getByRole("switch", { name: "自动记住" })
    await expect(auto).toHaveAttribute("aria-checked", "false")
    await auto.click()
    await expect.poll(async () => (await json(config)).memory?.auto_extract).toBe(true)
  })
})

test.describe("invalid config", () => {
  // A local MCP server without a command: the engine skips the entry and starts normally
  test.use({ config: { mcp: { broken: { type: "local" } } } })

  test("startup reports how many entries were skipped; settings show the file and entry", async ({ kit }) => {
    await expect(kit.page.getByText(/配置里有 \d+ 处写法不对/)).toBeVisible()
    await kit.settings()
    const panel = kit.page.getByRole("region", { name: "通用" })
    await expect(panel.getByText(/mcp\.broken/).first()).toBeVisible()
  })
})
