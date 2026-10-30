// `merak debug lsp`: query language servers for diagnostics and symbols.
import { EOL } from "os"
import { LSP } from "../../../agent/lsp/index"
import { Log } from "@merakcode/log/logger"
import { withInstance } from "../bootstrap"
import { setTimeout as delay } from "node:timers/promises"

export async function diagnostics(args: { file: string }) {
  await withInstance(process.cwd(), async () => {
    await LSP.touchFile(args.file, true)
    await delay(1000)
    process.stdout.write(JSON.stringify(await LSP.diagnostics(), null, 2) + EOL)
  })
}

export async function symbols(args: { query: string }) {
  await withInstance(process.cwd(), async () => {
    using _ = Log.Product.time("symbols")
    const results = await LSP.workspaceSymbol(args.query)
    process.stdout.write(JSON.stringify(results, null, 2) + EOL)
  })
}

export async function documentSymbols(args: { uri: string }) {
  await withInstance(process.cwd(), async () => {
    using _ = Log.Product.time("document-symbols")
    const results = await LSP.documentSymbol(args.uri)
    process.stdout.write(JSON.stringify(results, null, 2) + EOL)
  })
}
