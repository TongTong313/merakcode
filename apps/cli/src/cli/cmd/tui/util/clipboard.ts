import fs from "node:fs/promises"
import { platform, release } from "os"
import clipboardy from "clipboardy"
import { lazy } from "@merakcode/util/lazy"
import { tmpdir } from "os"
import path from "path"
import { Process } from "@merakcode/util/process"

/**
 * Writes text to clipboard via OSC 52 escape sequence.
 * This allows clipboard operations to work over SSH by having
 * the terminal emulator handle the clipboard locally.
 */
function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return
  const base64 = Buffer.from(text).toString("base64")
  const osc52 = `\x1b]52;c;${base64}\x07`
  const passthrough = process.env["TMUX"] || process.env["STY"]
  const sequence = passthrough ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52
  process.stdout.write(sequence)
}

export namespace Clipboard {
  export interface Content {
    data: string
    mime: string
  }

  export async function read(): Promise<Content | undefined> {
    const os = platform()

    if (os === "darwin") {
      const tmpfile = path.join(tmpdir(), "merakcode-clipboard.png")
      try {
        await Process.run(
          [
            "osascript",
            "-e",
            'set imageData to the clipboard as "PNGf"',
            "-e",
            `set fileRef to open for access POSIX file "${tmpfile}" with write permission`,
            "-e",
            "set eof fileRef to 0",
            "-e",
            "write imageData to fileRef",
            "-e",
            "close access fileRef",
          ],
          { nothrow: true },
        )
        const buffer = await fs.readFile(tmpfile)
        return { data: buffer.toString("base64"), mime: "image/png" }
      } catch {
      } finally {
        await fs.rm(tmpfile, { force: true })
      }
    }

    if (os === "win32" || release().includes("WSL")) {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }"
      const base64 = (
        await Process.run(["powershell.exe", "-NonInteractive", "-NoProfile", "-command", script], { nothrow: true })
      ).text()
      if (base64) {
        const imageBuffer = Buffer.from(base64.trim(), "base64")
        if (imageBuffer.length > 0) {
          return { data: imageBuffer.toString("base64"), mime: "image/png" }
        }
      }
    }

    if (os === "linux") {
      const wayland = (await Process.run(["wl-paste", "-t", "image/png"], { nothrow: true })).stdout
      if (wayland.byteLength > 0) {
        return { data: wayland.toString("base64"), mime: "image/png" }
      }
      const x11 = (await Process.run(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"], { nothrow: true }))
        .stdout
      if (x11.byteLength > 0) {
        return { data: x11.toString("base64"), mime: "image/png" }
      }
    }

    const text = await clipboardy.read().catch(() => {})
    if (text) {
      return { data: text, mime: "text/plain" }
    }
  }

  const getCopyMethod = lazy(() => {
    const os = platform()

    if (os === "darwin" && Process.which("osascript")) {
      return async (text: string) => {
        const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        await Process.run(["osascript", "-e", `set the clipboard to "${escaped}"`], { nothrow: true })
      }
    }

    if (os === "linux") {
      if (process.env["WAYLAND_DISPLAY"] && Process.which("wl-copy")) {
        return async (text: string) => {
          await Process.run(["wl-copy"], { stdin: text, nothrow: true })
        }
      }
      if (Process.which("xclip")) {
        return async (text: string) => {
          await Process.run(["xclip", "-selection", "clipboard"], { stdin: text, nothrow: true })
        }
      }
      if (Process.which("xsel")) {
        return async (text: string) => {
          await Process.run(["xsel", "--clipboard", "--input"], { stdin: text, nothrow: true })
        }
      }
    }

    if (os === "win32") {
      return async (text: string) => {
        // Pipe via stdin to avoid PowerShell string interpolation ($env:FOO, $(), etc.)
        await Process.run(
          [
            "powershell.exe",
            "-NonInteractive",
            "-NoProfile",
            "-Command",
            "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
          ],
          { stdin: text, nothrow: true },
        )
      }
    }

    return async (text: string) => {
      await clipboardy.write(text).catch(() => {})
    }
  })

  export async function copy(text: string): Promise<void> {
    writeOsc52(text)
    await getCopyMethod()(text)
  }
}
