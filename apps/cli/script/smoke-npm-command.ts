import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import { Process } from "@merakcode/util/process"

const execute = promisify(execFile)

/** Validate the CLI installed in an isolated npm consumer. */
export async function checkCli(root: string, version: string) {
  const command = path.join(root, "node_modules/.bin", process.platform === "win32" ? "merak.cmd" : "merak")
  const installed = await Process.run([command, "--version"], { cwd: root, timeout: 30_000 })
  if (installed.text().trim() !== version)
    throw new Error(`npm command version: expected ${version}, got ${installed.text().trim()}`)
  const launcher = path.join(root, "node_modules/merakcode/bin/merak")
  for (const executable of new Set(
    [process.execPath, process.env.MERAKCODE_SMOKE_CLI_NODE].filter((value): value is string => !!value),
  )) {
    const cli = await execute(executable, [launcher, "--version"], { cwd: root, timeout: 30_000, windowsHide: true })
    if (cli.stdout.trim() !== version) throw new Error(`npm CLI version: expected ${version}, got ${cli.stdout.trim()}`)
  }
}
