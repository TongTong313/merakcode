import { expect, test } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const script = (name: string) => readFileSync(path.join(import.meta.dirname, name), "utf8")
const nonAscii = (text: string) => [...text].filter((char) => char.charCodeAt(0) > 0x7e && char !== "\r")

// Windows PowerShell 5.1 does not decode downloaded scripts as UTF-8; non-ASCII text turns into garbage
test("install scripts are ASCII only", () => {
  expect(nonAscii(script("install.ps1"))).toEqual([])
  expect(nonAscii(script("install.sh"))).toEqual([])
})

// The install scripts and `merak upgrade` (apps/cli/src/cli/installation/release.ts) must share one layout
test("install scripts use the same layout as merak upgrade and install only the merak command", () => {
  const sh = script("install.sh")
  expect(sh).toContain(`home="\${MERAKCODE_INSTALL_DIR:-$HOME/.merakcode}"`)
  expect(sh).toContain(`bin="\${MERAKCODE_BIN_DIR:-$HOME/.local/bin}"`)
  expect(sh).toContain(`ln -sfn "$home/versions/$version/bin/merak" "$bin/merak"`)
  expect(sh).not.toContain("for command in")
  const ps1 = script("install.ps1")
  expect(ps1).toContain(`Join-Path $env:LOCALAPPDATA "merakcode"`)
  expect(ps1).toContain(`Join-Path $bin "merak.cmd"`)
  expect(ps1).toContain(`"@echo off\`r\`n\`"$target\\bin\\merak.cmd\`" %*"`)
  expect(ps1).not.toContain("foreach ($command")
})
