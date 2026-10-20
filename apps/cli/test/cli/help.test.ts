import { expect, test } from "vitest"
import path from "path"
import { Process } from "@merakcode/util/process"
import { runtime } from "../fixture/fixture"

const root = path.resolve(import.meta.dirname, "../..")

test("help output names the merak command", async () => {
  const proc = Process.spawn([...runtime, "src/index.ts", "--help"], {
    cwd: root,
    env: {
      ...process.env,
      MERAKCODE_MODELS_PATH: path.join(root, "../../packages/engine/test/tool/fixtures/models-api.json"),
      MERAKCODE_DISABLE_MODELS_FETCH: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(stderr).not.toContain("Failed to fetch models.dev")
  expect(code).toBe(0)
  expect(stdout).toContain("merak completion")
  expect(stdout).toContain("merak [project]")
  expect(stdout).not.toContain("merakcode completion")
})
