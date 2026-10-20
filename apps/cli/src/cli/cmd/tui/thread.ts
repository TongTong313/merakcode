import { cmd } from "../cmd"
import path from "path"
import { UI } from "../../ui"
import { iife } from "@merakcode/util/iife"
import { Log } from "@merakcode/log/logger"
import { withNetworkOptions } from "../../network-options"
import { text as streamText } from "stream/consumers"
import { I18n } from "../../i18n"
import { launchEngine } from "../../engine"
import { upgrade } from "../../upgrade"
import { TuiStartupDiagnostics } from "./startup-diagnostics"

const startupLog = Log.create({ source: "product", service: "tui.startup" })

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: I18n.t("app.command.tui"),
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: I18n.t("app.option.project"),
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: I18n.t("app.option.model"),
      })
      .option("continue", {
        alias: ["c"],
        describe: I18n.t("app.option.continue"),
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: I18n.t("app.option.session"),
      })
      .option("fork", {
        type: "boolean",
        describe: I18n.t("app.option.fork"),
      })
      .option("prompt", {
        type: "string",
        describe: I18n.t("app.option.prompt"),
      })
      .option("agent", {
        type: "string",
        describe: I18n.t("app.option.agent"),
      })
      // Start in auto mode (still switchable from the status bar).
      .option("auto", {
        type: "boolean",
        describe: I18n.t("app.option.auto"),
        default: false,
      }),
  handler: async (args) => {
    const started = Date.now()
    const checkpoint = (stage: string, extra: Record<string, unknown> = {}) =>
      startupLog.info("checkpoint", { stage, elapsed: Date.now() - started, ...extra })

    checkpoint("command.started", TuiStartupDiagnostics.environment())
    process.env["MERAKCODE_CLIENT"] = "tui"

    if (args.fork && !args.continue && !args.session) {
      UI.error(I18n.t("cli.forkRequires"))
      process.exitCode = 1
      return
    }

    // Resolve relative paths against PWD to preserve behavior when using --cwd flag
    const baseCwd = process.env.PWD ?? process.cwd()
    const cwd = args.project ? path.resolve(baseCwd, args.project) : process.cwd()
    try {
      process.chdir(cwd)
    } catch (e) {
      startupLog.error("checkpoint failed", {
        stage: "directory.changed",
        elapsed: Date.now() - started,
        directory: cwd,
        error: e instanceof Error ? e.message : String(e),
      })
      UI.error(I18n.t("cli.chdirFailed", { cwd }))
      return
    }
    checkpoint("directory.changed", { directory: cwd })

    const prompt = await iife(async () => {
      const piped = !process.stdin.isTTY ? await streamText(process.stdin) : undefined
      if (!args.prompt) return piped
      return piped ? piped + "\n" + args.prompt : args.prompt
    })

    // The engine is a serve child process of this same binary (spawned through the SDK). With explicit --port or
    // --hostname it still listens there for external clients (see engine.ts).
    const engineStarted = Date.now()
    checkpoint("engine.started")
    const engine = await launchEngine({
      cwd,
      client: "tui",
      env: {
        MERAKCODE_PRINT_LOGS: process.argv.includes("--print-logs") ? "1" : "0",
      },
    }).catch((error: Error) => {
      UI.error(error.message)
      process.exitCode = 1
    })
    if (!engine) return
    checkpoint("engine.ready", { duration: Date.now() - engineStarted, pid: engine.pid })

    const shutdown = () => engine.close()
    const terminate = () => {
      void shutdown().finally(() => process.exit(0))
    }
    process.once("SIGTERM", terminate)
    process.once("SIGHUP", terminate)
    if (process.platform === "win32") process.once("SIGBREAK", terminate)
    // The UI is unusable once the engine exits unexpectedly: report and exit instead of leaving it disconnected.
    void engine.exited.then((code) => {
      if (closing) return
      startupLog.error("engine exited", { code })
      UI.error(I18n.t("cli.engineExited", { code: String(code) }))
      process.exit(1)
    })
    let closing = false

    const { tui } = await import("./app")
    checkpoint("app.module.loaded")
    // Raw fetches (import/export, workflow logs) need the engine token too.
    const authorized = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      for (const [key, value] of new Headers(init?.headers)) headers.set(key, value)
      for (const [key, value] of Object.entries(engine.headers)) headers.set(key, value)
      return fetch(input, { ...init, headers })
    }) as typeof fetch
    const tuiPromise = tui({
      url: engine.url,
      fetch: authorized,
      headers: engine.headers,
      directory: cwd,
      // Check for upgrades once the UI is up (a slow or offline network does not block it); the result is shown in
      // the UI.
      update: new Promise<void>((resolve) => setTimeout(resolve, 1000).unref()).then(upgrade).catch(() => undefined),
      args: {
        continue: args.continue,
        sessionID: args.session,
        agent: args.agent,
        model: args.model,
        prompt,
        fork: args.fork,
        auto: args.auto,
      },
      onExit: async () => {
        checkpoint("app.exit-requested")
        closing = true
        await shutdown()
      },
    })
    checkpoint("app.invoked")

    try {
      await tuiPromise
      checkpoint("app.exited")
    } finally {
      closing = true
      await shutdown()
      process.off("SIGTERM", terminate)
      process.off("SIGHUP", terminate)
      if (process.platform === "win32") process.off("SIGBREAK", terminate)
    }
  },
})
