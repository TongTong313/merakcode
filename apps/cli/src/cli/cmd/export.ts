import type { Argv } from "yargs"
import path from "path"
import { EOL } from "os"
import * as prompts from "@clack/prompts"
import type { MerakCodeClient, Session } from "@merakcode/sdk/client"
import { formatTranscript } from "@merakcode/sdk/transcript"
import { Filesystem } from "@merakcode/util/filesystem"
import { cmd } from "./cmd"
import { withEngine } from "../engine"
import { UI } from "../ui"
import { I18n } from "../i18n"

type Format = "json" | "markdown"

/** JSON keeps everything and can be imported again with merak import; Markdown is for reading */
async function render(sdk: MerakCodeClient, sessionID: string, format: Format) {
  const exported = (await sdk.session.exportFull({ sessionID })).data
  if (!exported) return undefined
  if (format === "json") return JSON.stringify(exported, null, 2) + EOL
  return formatTranscript(exported.info, exported.messages, {
    thinking: true,
    toolDetails: true,
    assistantMetadata: false,
    lang: I18n.current() === "en-US" ? "en" : "zh",
  })
}

/** Title and the end of the ID, without characters file systems reject */
function filename(session: Session, format: Format) {
  const title = session.title
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
  return `${title ? `${title}-` : ""}${session.id.slice(-8)}.${format === "json" ? "json" : "md"}`
}

async function pick(sdk: MerakCodeClient) {
  UI.empty()
  prompts.intro(I18n.t("cli.export.intro"), { output: process.stderr })
  const sessions = await sdk.session.list(undefined, { throwOnError: true }).then((x) => x.data)
  if (sessions.length === 0) {
    prompts.log.error(I18n.t("cli.export.none"), { output: process.stderr })
    prompts.outro(I18n.t("cli.done"), { output: process.stderr })
    return undefined
  }
  sessions.sort((a, b) => b.time.updated - a.time.updated)
  const selected = await prompts.autocomplete({
    message: I18n.t("cli.export.select"),
    maxItems: 10,
    options: sessions.map((session) => ({
      label: session.title,
      value: session.id,
      hint: `${new Date(session.time.updated).toLocaleString()} • ${session.id.slice(-8)}`,
    })),
    output: process.stderr,
  })
  if (prompts.isCancel(selected)) throw new UI.CancelledError()
  prompts.outro(I18n.t("cli.export.running"), { output: process.stderr })
  return selected as string
}

export const ExportCommand = cmd({
  command: "export [sessionID]",
  describe: I18n.t("cli.export.describe"),
  builder: (yargs: Argv) => {
    return yargs
      .positional("sessionID", {
        describe: I18n.t("cli.export.sessionID"),
        type: "string",
      })
      .option("format", {
        describe: I18n.t("cli.export.format"),
        choices: ["json", "markdown"] as const,
        default: "json" as const,
      })
      .option("all", {
        describe: I18n.t("cli.export.all"),
        type: "boolean",
      })
      .option("out", {
        describe: I18n.t("cli.export.out"),
        type: "string",
      })
      .implies("all", "out")
  },
  handler: async (args) => {
    const format = args.format
    if (args.all) {
      const out = args.out!
      const count = await withEngine(async (sdk) => {
        const sessions = await sdk.session.list(undefined, { throwOnError: true }).then((x) => x.data)
        for (const session of sessions) {
          const text = await render(sdk, session.id, format)
          if (text) await Filesystem.write(path.join(out, filename(session, format)), text)
        }
        return sessions.length
      })
      process.stderr.write(I18n.t("cli.export.saved", { count, path: path.resolve(out) }) + EOL)
      return
    }

    process.stderr.write(I18n.t("cli.export.exporting", { session: args.sessionID ?? I18n.t("cli.export.latest") }))
    const result = await withEngine(async (sdk) => {
      const sessionID = args.sessionID ?? (await pick(sdk))
      if (!sessionID) return
      return { sessionID, text: await render(sdk, sessionID, format) }
    })
    if (!result) return
    if (!result.text) {
      UI.error(I18n.t("cli.session.notFound", { session: result.sessionID }))
      process.exit(1)
    }
    if (!args.out) {
      process.stdout.write(result.text)
      return
    }
    await Filesystem.write(args.out, result.text)
    process.stderr.write(I18n.t("cli.export.written", { path: path.resolve(args.out) }) + EOL)
  },
})
