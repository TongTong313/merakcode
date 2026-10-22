/**
 * merak logs: where the logs are, recent runs, one run's records, or follow the newest run.
 * Reads files only; never starts the engine.
 */
import type { Argv } from "yargs"
import { closeSync, openSync, readSync, statSync } from "fs"
import { EOL } from "os"
import { setTimeout as sleep } from "timers/promises"
import open from "open"
import { formatText, type LogRecord } from "@merakcode/log"
import { Log } from "@merakcode/log/logger"
import { filterRun, listRuns, readRecords } from "@merakcode/log/inspect"
import { resolveLogRoot } from "@merakcode/log/node"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { I18n } from "../i18n"

const COMPONENTS = ["cli", "server", "desktop"] as const

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const write = (text: string) => process.stdout.write(text)

function print(records: LogRecord[], json: boolean) {
  for (const record of records) write(json ? JSON.stringify(record) + EOL : formatText(record))
}

/** Prints lines appended to `file` until the process is stopped; starts over when the file is rotated */
async function follow(file: string, json: boolean) {
  let offset = statSync(file, { throwIfNoEntry: false })?.size ?? 0
  let rest = ""
  for (;;) {
    await sleep(300)
    const current = statSync(file, { throwIfNoEntry: false })?.size ?? 0
    if (current < offset) offset = 0
    if (current === offset) continue
    const buffer = Buffer.alloc(current - offset)
    const handle = openSync(file, "r")
    try {
      readSync(handle, buffer, 0, buffer.length, offset)
    } finally {
      closeSync(handle)
    }
    offset = current
    const lines = (rest + buffer.toString("utf8")).split("\n")
    rest = lines.pop() ?? ""
    print(
      lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as LogRecord]
        } catch {
          return []
        }
      }),
      json,
    )
  }
}

export const LogsCommand = cmd({
  command: "logs",
  describe: I18n.t("cli.logs.describe"),
  builder: (yargs: Argv) =>
    yargs
      .option("run", { describe: I18n.t("cli.logs.run"), type: "string" })
      .option("tail", { describe: I18n.t("cli.logs.tail"), type: "number" })
      .option("component", { describe: I18n.t("cli.logs.component"), type: "string", choices: COMPONENTS })
      .option("open", { describe: I18n.t("cli.logs.open"), type: "boolean" })
      .option("json", { describe: I18n.t("cli.logs.json"), type: "boolean" }),
  handler: async (args) => {
    const root = resolveLogRoot()
    const json = args.json ?? false
    const own = Log.file()
    const runs = listRuns(root)
      // This command's own log file exists before its first record (the one carrying the run id) is written, so it
      // is matched by path too; otherwise --tail can pick it as the newest run and follow an empty file
      .filter((run) => run.id !== Log.id() && !run.files.includes(own))
      .filter((run) => !args.component || run.component === args.component)

    if (args.open) {
      write(root + EOL)
      await open(root)
      return
    }

    if (args.run !== undefined) {
      const matched = filterRun(runs, args.run)
      if (!matched.length) {
        UI.error(I18n.t("cli.logs.runNotFound", { run: args.run }))
        process.exitCode = 1
        return
      }
      const records = matched
        .flatMap((run) => run.files.flatMap(readRecords))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence)
      if (json) write(JSON.stringify(records, null, 2) + EOL)
      else print(records, false)
      return
    }

    if (args.tail !== undefined || process.argv.includes("--tail")) {
      const count = args.tail && args.tail > 0 ? args.tail : 50
      const run = runs[0]
      if (!run) {
        UI.error(I18n.t("cli.logs.empty", { root }))
        process.exitCode = 1
        return
      }
      UI.println(UI.Style.TEXT_DIM + I18n.t("cli.logs.following", { run: run.id }) + UI.Style.TEXT_NORMAL)
      print(run.files.flatMap(readRecords).slice(-count), json)
      await follow(run.files.at(-1)!, json)
      return
    }

    if (json) {
      write(JSON.stringify({ root, runs }, null, 2) + EOL)
      return
    }
    write(I18n.t("cli.logs.root", { root }) + EOL)
    if (!runs.length) write(I18n.t("cli.logs.none") + EOL)
    for (const run of runs.slice(0, 10)) {
      write(`  ${run.started}  ${`${run.component}/${run.name}`.padEnd(16)}  ${run.id}  ${size(run.size)}${EOL}`)
    }
    UI.println(UI.Style.TEXT_DIM + I18n.t("cli.logs.hint") + UI.Style.TEXT_NORMAL)
  },
})
