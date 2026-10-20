// Thin shell for the run command.
//
// Only the command metadata (command, describe, builder options) lives here, so importing this file at CLI startup
// does not pull heavy dependencies (engine tools, server, provider, agent, @merakcode/sdk) into startup. The execution
// logic lives in ./run.handler and is loaded with a dynamic import only when the command runs; the bundler emits it as
// a separate chunk.
//
// The dynamic import must use the static relative string "./run.handler", not new URL or string concatenation, to
// avoid win32 path issues.

import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { I18n } from "../i18n"

// Re-exported so tests can keep importing it from "src/cli/cmd/run".
export { permissionDeniedCopy } from "./run.shared"

export const RunCommand = cmd({
  command: "run [message..]",
  describe: I18n.t("cli.run.describe"),
  builder: (yargs: Argv) => {
    return (
      yargs
        .positional("message", {
          describe: I18n.t("cli.run.message"),
          type: "string",
          array: true,
          default: [],
        })
        .option("command", {
          describe: I18n.t("cli.run.command"),
          type: "string",
        })
        .option("continue", {
          alias: ["c"],
          describe: I18n.t("cli.run.continue"),
          type: "boolean",
        })
        .option("session", {
          alias: ["s"],
          describe: I18n.t("app.option.session"),
          type: "string",
        })
        .option("fork", {
          describe: I18n.t("app.option.fork"),
          type: "boolean",
        })
        .option("model", {
          type: "string",
          alias: ["m"],
          describe: I18n.t("app.option.model"),
        })
        .option("agent", {
          type: "string",
          describe: I18n.t("app.option.agent"),
        })
        .option("format", {
          type: "string",
          choices: ["default", "json"],
          default: "default",
          describe: I18n.t("cli.run.format"),
        })
        .option("file", {
          alias: ["f"],
          type: "string",
          array: true,
          describe: I18n.t("cli.run.file"),
        })
        .option("title", {
          type: "string",
          describe: I18n.t("cli.run.title"),
        })
        .option("attach", {
          type: "string",
          describe: I18n.t("cli.run.attach"),
        })
        .option("dir", {
          type: "string",
          describe: I18n.t("cli.run.dir"),
        })
        .option("port", {
          type: "number",
          describe: I18n.t("cli.run.port"),
        })
        .option("variant", {
          type: "string",
          describe: I18n.t("cli.run.variant"),
        })
        .option("thinking", {
          type: "boolean",
          describe: I18n.t("cli.run.thinking"),
          default: false,
        })
        // Passed through as the permissionMode of session.prompt / session.command.
        .option("auto", {
          type: "boolean",
          describe: I18n.t("cli.run.option.auto"),
          default: false,
        })
    )
  },
  handler: async (args) => {
    const m = await import("./run.handler")
    return m.run(args)
  },
})
