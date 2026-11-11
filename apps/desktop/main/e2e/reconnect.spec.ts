import { readFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

test.use({
  script: {
    reply: ({ prompt }) =>
      prompt.includes("approval")
        ? { tool: "bash", args: { command: "printf 'never'" } }
        : { text: prompt.includes("second") ? "SECOND_AFTER_RESTART" : "FIRST_BEFORE_RESTART" },
  },
})

test("reconnects after an engine crash, restores history and clears old approvals", async ({ kit }) => {
  await kit.send("first")
  await expect(kit.text("FIRST_BEFORE_RESTART")).toBeVisible()
  await kit.send("approval")
  await expect(kit.approval()).toBeVisible()
  const connection = path.join(kit.root, "data", "engine.json")
  const before = JSON.parse(await readFile(connection, "utf8")) as { pid: number }
  process.kill(before.pid)
  await expect
    .poll(async () => {
      const info = await readFile(connection, "utf8").then(
        (body) => JSON.parse(body) as { pid: number },
        () => undefined,
      )
      return info?.pid && info.pid !== before.pid
    })
    .toBeTruthy()
  await expect(kit.approval()).toHaveCount(0)
  await kit.send("second")
  await expect(kit.text("SECOND_AFTER_RESTART")).toBeVisible()
  await expect(kit.page.getByText("FIRST_BEFORE_RESTART", { exact: true })).toHaveCount(1)
})
