import { cmd } from "../cmd"
import { I18n } from "../../i18n"

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: I18n.t("app.command.attach"),
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: I18n.t("cli.attach.url"),
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: I18n.t("cli.attach.dir"),
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: I18n.t("app.option.session"),
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: I18n.t("cli.attach.password"),
      }),
  handler: async (args) => {
    const directory = (() => {
      if (!args.dir) return undefined
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        // If the directory doesn't exist locally (remote attach), pass it through.
        return args.dir
      }
    })()
    const headers = (() => {
      const password = args.password ?? process.env.MERAKCODE_SERVER_PASSWORD
      if (!password) return undefined
      const auth = `Basic ${Buffer.from(`merakcode:${password}`).toString("base64")}`
      return { Authorization: auth }
    })()
    const { tui } = await import("./app")
    await tui({
      url: args.url,
      args: { sessionID: args.session },
      directory,
      headers,
    })
  },
})
