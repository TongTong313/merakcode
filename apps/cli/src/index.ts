// The product version must be set before any engine module evaluates (see ./product-version).
import "./product-version"

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { commandName } from "../bin/cli-name.cjs"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { Log } from "@merakcode/log/logger"
import { ProviderCommand } from "./cli/cmd/provider"
import { AgentCommand } from "./cli/cmd/agent"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { I18n } from "./cli/i18n"
import { Installation } from "./cli/installation"
import { NamedError } from "@merakcode/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL, release, cpus } from "os"
import { SessionCommand } from "./cli/cmd/session"
import { SkillCommand } from "./cli/cmd/skill"
import { PluginCommand } from "./cli/cmd/plugin"
import { LogsCommand } from "./cli/cmd/logs"
import { DoctorCommand } from "./cli/cmd/doctor"
import { BugReportCommand } from "./cli/cmd/bug-report"
import { SandboxCommand } from "./cli/cmd/sandbox"
import { installFatalHandlers } from "./cli/fatal"
import { Exit } from "./cli/shutdown"

installFatalHandlers()

const authCommands = [(await import("./cli/cmd/upgrade")).UpgradeCommand]

/**
 * yargs' built-in UI strings (Commands:, [boolean], argument errors, etc.). The bundled release cannot find yargs'
 * locale files while development follows the system language, so the locale is pinned to English and the strings are
 * overridden with cli.yargs.* from the locales in the UI language.
 */
const YARGS = {
  "Commands:": "commands",
  "Options:": "options",
  "Positionals:": "positionals",
  "Examples:": "examples",
  command: "command",
  boolean: "boolean",
  count: "count",
  string: "string",
  number: "number",
  array: "array",
  required: "required",
  default: "default",
  "default:": "defaultColon",
  "choices:": "choices",
  "aliases:": "aliases",
  deprecated: "deprecated",
  "deprecated: %s": "deprecatedReason",
  "generated-value": "generatedValue",
  "Not enough non-option arguments: got %s, need at least %s": "notEnough",
  "Too many non-option arguments: got %s, maximum of %s": "tooMany",
  "Missing required argument: %s": "missing",
  "Unknown argument: %s": "unknownArgument",
  "Unknown command: %s": "unknownCommand",
  "Invalid values:": "invalid",
  "Argument: %s, Given: %s, Choices: %s": "choice",
  "Implications failed:": "implications",
  "Arguments %s and %s are mutually exclusive": "exclusive",
  "Did you mean %s?": "didYouMean",
}
// yargs looks these up with plural forms (__n); the same text is used for singular and plural.
const PLURAL = new Set([
  "Not enough non-option arguments: got %s, need at least %s",
  "Too many non-option arguments: got %s, maximum of %s",
  "Missing required argument: %s",
  "Unknown argument: %s",
  "Unknown command: %s",
])
const yargsStrings = Object.fromEntries(
  Object.entries(YARGS).map(([text, key]) => {
    const value = I18n.t(`cli.yargs.${key}`)
    return [text, PLURAL.has(text) ? { one: value, other: value } : value]
  }),
) as unknown as Record<string, string>

const cli = yargs(hideBin(process.argv))
  .locale("en")
  .updateStrings(yargsStrings)
  .parserConfiguration({ "populate--": true })
  .scriptName(commandName)
  .wrap(100)
  .help("help", I18n.t("cli.root.help"))
  .alias("help", "h")
  .version("version", I18n.t("cli.root.version"), Installation.VERSION)
  .alias("version", "v")
  .option("print-logs", {
    describe: I18n.t("cli.root.printLogs"),
    type: "boolean",
  })
  .option("log-level", {
    describe: I18n.t("cli.root.logLevel"),
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .middleware(async (opts) => {
    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      version: Installation.VERSION,
      component: ["serve", "web"].includes(String(opts._[0])) ? "backend" : undefined,
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    process.env.AGENT = "1"
    process.env.MERAKCODE = "1"

    Log.Product.info("merakcode", {
      version: Installation.VERSION,
      runtime: `${process.release.name} ${process.version}`,
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpuModel: cpus()[0]?.model,

      command: process.argv.slice(2).find((arg) => !arg.startsWith("-")),
      flags: process.argv
        .slice(2)
        .filter((arg) => arg.startsWith("-"))
        .map((arg) => arg.split("=", 1)[0]),
    })
  })
  .usage("\n" + UI.logo())
  .completion("completion", I18n.t("cli.root.completion"))
  .command({
    command: "$0",
    describe: false,
    handler: () => {
      cli.showHelp("log")
    },
  })
  .command(AcpCommand)
  .command(McpCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(authCommands)
  .command(ProviderCommand)
  .command(AgentCommand)
  .command(ServeCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(SessionCommand)
  .command(SkillCommand)
  .command(PluginCommand)
  .command(LogsCommand)
  .command(DoctorCommand)
  .command(BugReportCommand)
  .command(SandboxCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp("log")
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  await cli.parse()
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }
  Log.Product.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error(I18n.t("cli.unexpected", { file: Log.file(), run: Log.id() }) + EOL)
    console.error(e instanceof Error ? e.message : String(e))
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  // Cleanup registered by commands that loaded the engine (e.g. stopping file watchers, see cli/bootstrap.ts).
  await Exit.run()
  await Log.shutdown()
  process.exit()
}
