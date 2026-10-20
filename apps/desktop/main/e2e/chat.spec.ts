import { readFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

test.describe("chat", () => {
  // The reply says whether the system prompt asks for Chinese replies, so the UI shows it directly
  test.use({
    script: {
      reply: ({ prompt, system }) => ({
        text: `收到：${prompt}（${system.includes("Reply to the user in Chinese") ? "要求中文" : "没要求中文"}）`,
      }),
    },
  })

  test("shows the model reply; Chinese input makes the system prompt ask for Chinese replies", async ({ kit }) => {
    await kit.send("你好")
    await expect(kit.text("收到：你好（要求中文）")).toBeVisible({ timeout: 60_000 })
    expect(kit.requests()).toBeGreaterThan(0)
  })
})

test.describe("file read and write", () => {
  test.use({
    script: {
      reply: ({ toolResults }) => {
        if (toolResults.length === 0) return { tool: "read", args: { filePath: "notes.txt" } }
        if (toolResults.length === 1)
          return { tool: "write", args: { filePath: "out.txt", content: "written by e2e\n" } }
        return { text: "E2E_DONE" }
      },
    },
  })

  test("ask mode reads files and writes inside the workspace without approval", async ({ kit }) => {
    await kit.send("读 notes.txt 再写 out.txt")
    await expect(kit.text("E2E_DONE")).toBeVisible({ timeout: 90_000 })
    expect(await readFile(path.join(kit.project, "out.txt"), "utf8")).toBe("written by e2e\n")
  })
})

test.describe("math", () => {
  test.use({ script: { reply: () => ({ text: "质能方程：$$E = mc^2$$" }) } })

  test("renders LaTeX in replies as math instead of source", async ({ kit }) => {
    await kit.send("写一个公式")
    // KaTeX output carries MathML (role="math"), and the source $ does not appear in the reply
    const reply = kit.text(/质能方程/)
    await expect(reply).toBeVisible({ timeout: 60_000 })
    await expect(kit.page.getByRole("math").filter({ visible: true }).last()).toBeVisible()
    await expect(reply).not.toContainText("$")
  })
})
