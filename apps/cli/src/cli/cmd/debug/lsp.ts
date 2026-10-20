import { cmd } from "../cmd"
import { host } from "./host"
import { I18n } from "../../i18n"

export const LSPCommand = cmd({
  command: "lsp",
  describe: I18n.t("cli.debug.lsp"),
  builder: (yargs) =>
    yargs.command(DiagnosticsCommand).command(SymbolsCommand).command(DocumentSymbolsCommand).demandCommand(),
  async handler() {},
})

const DiagnosticsCommand = cmd({
  command: "diagnostics <file>",
  describe: I18n.t("cli.debug.lspDiagnostics"),
  builder: (yargs) => yargs.positional("file", { type: "string", demandOption: true }),
  async handler(args) {
    const m = await (await host()).debug.lsp()
    return m.diagnostics(args)
  },
})

export const SymbolsCommand = cmd({
  command: "symbols <query>",
  describe: I18n.t("cli.debug.lspSymbols"),
  builder: (yargs) => yargs.positional("query", { type: "string", demandOption: true }),
  async handler(args) {
    const m = await (await host()).debug.lsp()
    return m.symbols(args)
  },
})

export const DocumentSymbolsCommand = cmd({
  command: "document-symbols <uri>",
  describe: I18n.t("cli.debug.lspDocumentSymbols"),
  builder: (yargs) => yargs.positional("uri", { type: "string", demandOption: true }),
  async handler(args) {
    const m = await (await host()).debug.lsp()
    return m.documentSymbols(args)
  },
})
