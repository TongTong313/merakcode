import { expect, test } from "vitest"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Archive } from "../lib/archive"
import { Process } from "@merakcode/util/process"

const script = (name: string) => readFileSync(path.join(import.meta.dirname, name), "utf8")
const nonAscii = (text: string) => [...text].filter((char) => char.charCodeAt(0) > 0x7e && char !== "\r")

// Windows PowerShell 5.1 does not decode downloaded scripts as UTF-8; non-ASCII text turns into garbage
test("install scripts are ASCII only", () => {
  expect(nonAscii(script("install.ps1"))).toEqual([])
  expect(nonAscii(script("install.sh"))).toEqual([])
})

// merak has no UI of its own: run without a command it only prints the help
test("install scripts end by pointing to the list of commands", () => {
  for (const name of ["install.sh", "install.ps1"])
    expect(script(name)).toContain("Run 'merak --help' to see the commands.")
})

// The install scripts and `merak upgrade` (apps/cli/src/cli/installation/release.ts) must share one layout
test("install scripts use the same layout as merak upgrade and install only the merak command", () => {
  const sh = script("install.sh")
  expect(sh).toContain(`home="\${MERAKCODE_INSTALL_DIR:-\${MERAKCODE_HOME:-$HOME/.merakcode}}"`)
  expect(sh).toContain(`bin="\${MERAKCODE_BIN_DIR:-$HOME/.local/bin}"`)
  expect(sh).toContain(`ln -sfn "$home/versions/$version/bin/merak" "$bin/merak"`)
  expect(sh).not.toContain("for command in")
  const ps1 = script("install.ps1")
  expect(ps1).toContain(`elseif ($env:MERAKCODE_HOME) { $env:MERAKCODE_HOME } else { Join-Path $HOME ".merakcode" }`)
  expect(ps1).toContain(`Join-Path $bin "merak.cmd"`)
  expect(ps1).toContain(`"@echo off\`r\`n\`"$target\\bin\\merak.cmd\`" %*"`)
  expect(ps1).not.toContain("foreach ($command")
})

test("the native installer installs, reinstalls and upgrades from a local release, and rejects corrupt downloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "merakcode install test "))
  const windows = process.platform === "win32"
  const platform = `${windows ? "windows" : process.platform}-${process.arch}`
  const assets = new Map<string, Buffer>()
  let fault: "none" | "missing-checksum" | "corrupt-archive" = "none"
  const server = createServer((request, response) => {
    const file = assets.get(request.url ?? "")
    response.writeHead(file ? 200 : 404)
    if (fault === "missing-checksum" && request.url?.endsWith("SHA256SUMS")) {
      response.end("invalid checksum\n")
      return
    }
    response.end(
      fault === "corrupt-archive" && file && !request.url?.endsWith("SHA256SUMS")
        ? Buffer.concat([file, Buffer.from("corrupt")])
        : file,
    )
  })
  try {
    const sums: string[] = []
    for (const version of ["1.0.0", "1.0.1"]) {
      const name = `merakcode-${version}-${platform}`
      const release = path.join(root, name)
      await mkdir(path.join(release, "bin"), { recursive: true })
      await mkdir(path.join(release, "node", "bin"), { recursive: true })
      const command = path.join(release, "bin", windows ? "merak.cmd" : "merak")
      await writeFile(command, windows ? `@echo off\r\necho ${version}\r\n` : `#!/bin/sh\nprintf '${version}\\n'\n`)
      await chmod(command, 0o755)
      const node = path.join(release, "node", "bin", "node")
      await writeFile(node, "#!/bin/sh\nprintf 'v26.12.0\\n'\n")
      await chmod(node, 0o755)
      const archive = `${name}.${windows ? "zip" : "tar.gz"}`
      await Archive.create(release, path.join(root, archive))
      const content = await readFile(path.join(root, archive))
      assets.set(`/${archive}`, content)
      sums.push(`${createHash("sha256").update(content).digest("hex")}  ${archive}`)
    }
    assets.set("/SHA256SUMS", Buffer.from(sums.join("\n") + "\n"))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    const bin = path.join(root, "commands with spaces")
    const install = (version: string) =>
      promisify(execFile)(
        windows ? "powershell.exe" : "/bin/sh",
        windows
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              "Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop; & $env:MERAKCODE_INSTALL_TEST_SCRIPT",
            ]
          : [path.join(import.meta.dirname, "install.sh")],
        {
          env: {
            ...process.env,
            // PowerShell 7's inherited module path can shadow Windows PowerShell 5.1's built-in commands.
            ...(windows
              ? { PSModulePath: path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/Modules") }
              : {}),
            MERAKCODE_VERSION: version,
            MERAKCODE_INSTALL_DIR: path.join(root, "installed"),
            MERAKCODE_BIN_DIR: bin,
            MERAKCODE_DOWNLOAD_BASE: `http://127.0.0.1:${port}`,
            MERAKCODE_NO_MODIFY_PATH: "1",
            MERAKCODE_INSTALL_TEST_SCRIPT: path.join(import.meta.dirname, "install.ps1"),
          },
          timeout: 30_000,
          windowsHide: true,
        },
      )
    const version = async () => {
      const result = await Process.run([path.join(bin, windows ? "merak.cmd" : "merak"), "--version"])
      return result.stdout.toString().trim()
    }
    await install("1.0.0")
    expect(await version()).toBe("1.0.0")
    await install("1.0.0")
    expect(await version()).toBe("1.0.0")
    await install("1.0.1")
    expect(await version()).toBe("1.0.1")
    fault = "missing-checksum"
    await expect(install("1.0.0")).rejects.toThrow(/is not listed in SHA256SUMS/)
    expect(await version()).toBe("1.0.1")
    fault = "corrupt-archive"
    await expect(install("1.0.0")).rejects.toThrow(/checksum mismatch/i)
    expect(await version()).toBe("1.0.1")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)
