import { readFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

test.use({
  script: {
    reply: ({ toolResults }) => {
      if (!toolResults.length) return { tool: "read_file", args: { path: "notes.txt" } }
      if (toolResults.length === 1)
        return { tool: "write_file", args: { path: "out.txt", content: "written by e2e\n" } }
      return { text: "FILES_READY" }
    },
  },
})

test("shows actual file tool results and writes only after approval", async ({ kit }) => {
  await kit.send("Read and write")
  await expect(kit.approval()).toContainText("out.txt")
  await expect(readFile(path.join(kit.project, "out.txt"), "utf8")).rejects.toThrow()
  await kit.approval().getByRole("button", { name: "允许这一次", exact: true }).click()
  await expect(kit.text("FILES_READY")).toBeVisible()
  expect(await readFile(path.join(kit.project, "out.txt"), "utf8")).toBe("written by e2e\n")
  await kit.page.getByText("执行过程", { exact: true }).click()
  await kit.page.getByRole("button", { name: /notes.txt/ }).click()
  await expect(kit.text("hello from e2e")).toBeVisible()
})
