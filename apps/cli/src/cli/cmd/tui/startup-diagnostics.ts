import os from "os"
import type { CliRenderer } from "@opentui/core"

const decoder = new TextDecoder()

export namespace TuiStartupDiagnostics {
  /**
   * Only expose terminal/runtime fields useful for startup diagnosis. Deliberately
   * avoid dumping process.env because it may contain provider credentials.
   */
  export function environment(directory = process.cwd()) {
    return {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      runtime: `${process.release.name} ${process.version}`,
      directory,
      stdinTTY: process.stdin.isTTY === true,
      stdoutTTY: process.stdout.isTTY === true,
      columns: process.stdout.columns,
      rows: process.stdout.rows,
      term: process.env.TERM,
      colorTerm: process.env.COLORTERM,
      termProgram: process.env.TERM_PROGRAM,
      lang: process.env.LANG,
      sessionType: process.env.XDG_SESSION_TYPE,
      desktop: process.env.XDG_CURRENT_DESKTOP ?? process.env.DESKTOP_SESSION,
      ssh: Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY),
      tmux: Boolean(process.env.TMUX),
      display: Boolean(process.env.DISPLAY),
      wayland: Boolean(process.env.WAYLAND_DISPLAY),
    }
  }

  export function visibleCharacters(value: string) {
    let count = 0
    for (const char of value) {
      if (char === "\0" || /\s/u.test(char)) continue
      count++
    }
    return count
  }

  /** Return frame metrics only. Never include the rendered text itself. */
  export function frame(renderer: CliRenderer) {
    const buffer = renderer.currentRenderBuffer
    const text = decoder.decode(buffer.getRealCharBytes(true))
    const native = renderer.getNativeStats()
    return {
      frameID: renderer.frameId,
      width: buffer.width,
      height: buffer.height,
      visibleCharacters: visibleCharacters(text),
      nativeFrameCount: native.nativeFrameCount,
      cellsUpdated: native.cellsUpdated,
      scheduler: renderer.getSchedulerState(),
    }
  }

  /** Strip query/fragment data so startup request logs cannot leak credentials. */
  export function requestPath(value: string) {
    try {
      return new URL(value).pathname
    } catch {
      return "<invalid-url>"
    }
  }
}
