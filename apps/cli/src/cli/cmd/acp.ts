import { Log } from "@merakcode/log/logger"
import { cmd } from "./cmd"
import { I18n } from "../i18n"
import { UI } from "../ui"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ACP } from "../acp/agent"
import { createMerakCodeClient } from "@merakcode/sdk/client"
import { withNetworkOptions } from "../network-options"
import { launchEngine } from "../engine"

const log = Log.create({ source: "product", service: "acp-command" })

export const AcpCommand = cmd({
  command: "acp",
  describe: I18n.t("cli.acp.describe"),
  builder: (yargs) => {
    return withNetworkOptions(yargs).option("cwd", {
      describe: I18n.t("cli.acp.cwd"),
      type: "string",
      default: process.cwd(),
    })
  },
  handler: async (args) => {
    // The ACP adapter is only an SDK client: the engine runs in a separate serve process and stdout is reserved for
    // protocol messages.
    const engine = await launchEngine({ cwd: args.cwd, client: "acp" }).catch((error: Error) => {
      UI.error(error.message)
      process.exit(1)
    })
    let closing = false
    void engine.exited.then((code) => {
      if (closing) return
      log.error("engine exited", { code })
      UI.error(I18n.t("cli.engineExited", { code: String(code) }))
      process.exit(1)
    })
    try {
      const sdk = createMerakCodeClient({ baseUrl: engine.url, headers: engine.headers, clientRun: Log.id() })

      const input = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise<void>((resolve, reject) => {
            process.stdout.write(chunk, (err) => {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })
        },
      })
      const output = new ReadableStream<Uint8Array>({
        start(controller) {
          process.stdin.on("data", (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk))
          })
          process.stdin.on("end", () => controller.close())
          process.stdin.on("error", (err) => controller.error(err))
        },
      })

      const stream = ndJsonStream(input, output)
      new AgentSideConnection((conn) => new ACP.Agent(conn, { sdk }), stream)

      log.info("setup connection")
      process.stdin.resume()
      await new Promise((resolve, reject) => {
        process.stdin.on("end", resolve)
        process.stdin.on("error", reject)
      })
    } finally {
      closing = true
      await engine.close()
    }
  },
})
