import fs from "node:fs/promises"
import path from "node:path"

/**
 * A command named name in dir that runs the TypeScript fake CLI in this folder with this process's loader, as npm
 * installs a CLI: a .cmd shim on Windows, a script elsewhere
 */
export async function shim(dir: string, name: string, fixture: string) {
  const script = path.join(import.meta.dirname, fixture)
  const flags = process.execArgv.map((arg) => `"${arg}"`).join(" ")
  const command = process.platform === "win32" ? path.join(dir, `${name}.cmd`) : path.join(dir, name)
  await fs.writeFile(
    command,
    process.platform === "win32"
      ? `@"${process.execPath}" ${flags} "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" ${flags} "${script}" "$@"\n`,
    { mode: 0o755 },
  )
  return command
}
