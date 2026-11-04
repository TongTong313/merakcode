import { readFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "./fixture"

test("repeated quit requests preserve asynchronous cleanup and exit normally", async ({ kit }) => {
  const marker = path.join(kit.root, "quit-events")
  const appProcess = kit.app.process()
  await kit.app
    .evaluate(({ app }, file) => {
      const fs = process.getBuiltinModule("fs")
      app.on("before-quit", (event) => fs.appendFileSync(file, `${JSON.stringify(event.defaultPrevented)}\n`))
      app.quit()
      app.quit()
    }, marker)
    .catch((error: Error) => {
      if (!/closed/i.test(error.message)) throw error
    })
  await expect
    .poll(async () =>
      (await readFile(marker, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    )
    .toEqual([true, true])
  await expect.poll(() => appProcess.exitCode, { timeout: 30000 }).toBe(0)
})
