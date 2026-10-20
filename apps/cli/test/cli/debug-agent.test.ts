import { expect, test } from "vitest"
import path from "path"
import { Process } from "@merakcode/util/process"
import { Filesystem } from "@merakcode/util/filesystem"
import { runtime, tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dirname, "../..")

test("debug agent --tool runs a tool directly under the agent's permission rules and prints the result", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => Filesystem.write(path.join(dir, "notes.txt"), "debug-agent-marker"),
  })
  const proc = Process.spawn(
    [
      ...runtime,
      path.join(root, "src/index.ts"),
      "debug",
      "agent",
      "build",
      "--tool",
      "read",
      "--params",
      JSON.stringify({ filePath: path.join(tmp.path, "notes.txt") }),
    ],
    {
      cwd: tmp.path,
      env: {
        ...process.env,
        MERAKCODE_MODELS_PATH: path.join(root, "../../packages/engine/test/tool/fixtures/models-api.json"),
        MERAKCODE_DISABLE_MODELS_FETCH: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(stderr).not.toContain("not iterable")
  expect(code).toBe(0)
  expect(stdout).toContain("debug-agent-marker")
}, 120_000)
