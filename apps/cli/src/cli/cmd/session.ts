import type { Argv } from "yargs"
import { cmd } from "./cmd"
import type { Session } from "@merakcode/sdk/client"
import { withEngine } from "../engine"
import { I18n } from "../i18n"
import { Locale } from "@merakcode/util/locale"
import { EOL } from "os"
import path from "path"
import { Process } from "@merakcode/util/process"
import { Filesystem } from "@merakcode/util/filesystem"

async function pagerCmd(): Promise<string[]> {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = Process.which("less")
  if (lessOnPath) {
    if (await Filesystem.size(lessOnPath)) return [lessOnPath, ...lessOptions]
  }

  const bash = process.env.MERAKCODE_GIT_BASH_PATH
  if (bash) {
    const less = path.join(bash, "..", "..", "usr", "bin", "less.exe")
    if (await Filesystem.size(less)) return [less, ...lessOptions]
  }

  const git = Process.which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (await Filesystem.size(less)) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: I18n.t("cli.session.describe"),
  builder: (yargs: Argv) => yargs.command(SessionListCommand).demandCommand(),
  async handler() {},
})

export const SessionListCommand = cmd({
  command: "list",
  describe: I18n.t("cli.session.list"),
  builder: (yargs: Argv) => {
    return yargs
      .option("max-count", {
        alias: "n",
        describe: I18n.t("cli.session.maxCount"),
        type: "number",
      })
      .option("format", {
        describe: I18n.t("cli.session.format"),
        type: "string",
        choices: ["table", "json"],
        default: "table",
      })
  },
  handler: async (args) => {
    const sessions = await withEngine((sdk) =>
      sdk.session.list({ roots: true }, { throwOnError: true }).then((result) => result.data),
    )
    sessions.sort((a, b) => b.time.updated - a.time.updated)

    const limitedSessions = args.maxCount ? sessions.slice(0, args.maxCount) : sessions

    if (limitedSessions.length === 0) {
      return
    }

    let output: string
    if (args.format === "json") {
      output = formatSessionJSON(limitedSessions)
    } else {
      output = formatSessionTable(limitedSessions)
    }

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      const proc = Process.spawn(await pagerCmd(), {
        stdin: "pipe",
        stdout: "inherit",
        stderr: "inherit",
      })

      // Writing fails with EPIPE if the pager exits early (e.g. pressing q in less); ignore it.
      proc.stdin!.on("error", () => {})
      proc.stdin!.write(output)
      proc.stdin!.end()
      await proc.exited
    } else {
      console.log(output)
    }
  },
})

function formatSessionTable(sessions: Session[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}
