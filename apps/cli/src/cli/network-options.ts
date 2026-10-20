// Network flag definitions (--port, --hostname, etc.): just the option table, no config reads, so the TUI can use it.
import type { Argv, InferredOptionTypes } from "yargs"
import { I18n } from "./i18n"

const options = {
  port: {
    type: "number" as const,
    describe: I18n.t("cli.network.port"),
  },
  hostname: {
    type: "string" as const,
    describe: I18n.t("cli.network.hostname"),
    default: "127.0.0.1",
  },
  mdns: {
    type: "boolean" as const,
    describe: I18n.t("cli.network.mdns"),
    default: false,
  },
  "mdns-domain": {
    type: "string" as const,
    describe: I18n.t("cli.network.mdnsDomain"),
    default: "merakcode.local",
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: I18n.t("cli.network.cors"),
    default: [] as string[],
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}
