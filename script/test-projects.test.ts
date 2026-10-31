import { expect, test } from "vitest"
import { availableParallelism } from "node:os"
import { fileURLToPath } from "node:url"
import { Process } from "@merakcode/util/process"

test("engine test projects enforce the configured worker budget", async () => {
  const root = fileURLToPath(new URL("../packages/engine", import.meta.url))
  const result = await Process.run([
    process.execPath,
    "--input-type=module",
    "--eval",
    `import { createVitest } from "vitest/node";
     const runner = await createVitest({ root: ${JSON.stringify(root)}, watch: false, run: false });
     try {
       console.log(JSON.stringify({ workers: runner.config.maxWorkers, projects: runner.projects.map(project => ({
         name: project.name, workers: project.config.maxWorkers
       })) }));
     } finally { await runner.close() }`,
  ])
  const config = JSON.parse(result.text()) as {
    workers: number
    projects: { name: string; workers: number }[]
  }
  expect(config.projects.map((project) => project.name)).toEqual(["engine", "sandbox"])
  for (const project of config.projects) expect(project.workers, project.name).toBe(config.workers)
  if (process.platform !== "win32") return
  expect(config.workers).toBeLessThanOrEqual(4)
  expect(config.workers).toBeLessThanOrEqual(Math.max(1, availableParallelism() / 2))
})
