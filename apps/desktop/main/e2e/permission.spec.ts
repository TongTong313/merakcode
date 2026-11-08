import { access } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

test.use({
  script: {
    reply: ({ toolResults }) =>
      toolResults.length
        ? { text: `RESULT ${toolResults.at(-1)}` }
        : { tool: "bash", args: { command: "printf '42'" } },
  },
})

test("allows one command and asks again on the next turn", async ({ kit }) => {
  for (const prompt of ["first", "second"]) {
    await kit.send(prompt)
    await expect(kit.approval()).toContainText("printf")
    await kit.approval().getByRole("button", { name: "允许这一次", exact: true }).click()
    await expect(kit.text("RESULT 42")).toBeVisible()
    await expect(kit.approval()).toHaveCount(0)
  }
})

test.describe("denial", () => {
  test.use({
    script: {
      reply: ({ toolResults }) =>
        toolResults.length
          ? { text: `DENIED ${toolResults.at(-1)}` }
          : { tool: "write_file", args: { path: "denied.txt", content: "must not be written" } },
    },
  })
  test("rejects the write and gives its reason to the model", async ({ kit }) => {
    await kit.send("write")
    await kit.approval().getByRole("button", { name: "拒绝", exact: true }).click()
    await expect(kit.text(/DENIED/)).toBeVisible()
    await expect(access(path.join(kit.project, "denied.txt"))).rejects.toThrow()
  })
})

test.describe("questions", () => {
  test.use({
    script: {
      reply: ({ toolResults }) =>
        toolResults.length
          ? { text: `ANSWER ${toolResults.at(-1)}` }
          : { tool: "ask_user", args: { text: "Choose a color", options: ["Blue", "Green"] } },
    },
  })
  test("sends a selected answer and supports skipping the next question", async ({ kit }) => {
    await kit.send("ask")
    await kit.page.getByRole("button", { name: "Blue", exact: true }).click()
    await kit.page.getByRole("button", { name: "提交", exact: true }).click()
    await expect(kit.text("ANSWER Blue")).toBeVisible()
    await kit.send("ask again")
    await kit.page.getByRole("button", { name: "跳过", exact: true }).click()
    await expect(kit.text(/ANSWER.*cancelled/)).toBeVisible()
  })
})
