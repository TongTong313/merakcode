import { expect, test } from "vitest"
import { spawn } from "node:child_process"
import path from "node:path"
import { cli, tmpdir } from "../fixture/fixture"

// The desktop app starts serve with an IPC channel. When the main process exits (including a crash or a forced kill)
// the channel closes, and serve must shut down on its own instead of lingering as an orphan holding the port. Windows
// cannot send SIGTERM, so this is the only graceful way out there
test("serve started over IPC exits on its own once the parent disconnects", async () => {
  await using tmp = await tmpdir()
  const child = spawn(cli[0]!, [...cli.slice(1), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: tmp.path,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      MERAKCODE_DISABLE_CATALOG_FETCH: "1",
      MERAKCODE_HOME: path.join(tmp.path, "merakcode"),
    },
  })
  let output = ""
  child.stdout!.on("data", (chunk) => (output += chunk))
  child.stderr!.resume()
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
  for (let waited = 0; !output.includes("listening on") && waited < 60_000; waited += 100)
    await new Promise((resolve) => setTimeout(resolve, 100))
  expect(output).toContain("listening on")
  child.disconnect()
  const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 15_000))])
  if (code === "timeout") child.kill()
  expect(code).toBe(0)
}, 90_000)
