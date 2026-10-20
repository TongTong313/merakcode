// `merak debug rg`: exercise the bundled ripgrep (tree, files, search).
import { EOL } from "os"
import { Ripgrep } from "../../file/ripgrep"
import { Instance } from "../../project/instance"
import { withInstance } from "../bootstrap"

export async function tree(args: { limit?: number }) {
  await withInstance(process.cwd(), async () => {
    process.stdout.write((await Ripgrep.tree({ cwd: Instance.directory, limit: args.limit })) + EOL)
  })
}

export async function files(args: { query?: string; glob?: string; limit?: number }) {
  await withInstance(process.cwd(), async () => {
    const files: string[] = []
    for await (const file of Ripgrep.files({
      cwd: Instance.directory,
      glob: args.glob ? [args.glob] : undefined,
    })) {
      files.push(file)
      if (args.limit && files.length >= args.limit) break
    }
    process.stdout.write(files.join(EOL) + EOL)
  })
}

export async function search(args: { pattern: string; glob?: unknown; limit?: number }) {
  const results = await Ripgrep.search({
    cwd: process.cwd(),
    pattern: args.pattern,
    glob: args.glob as string[] | undefined,
    limit: args.limit,
  })
  process.stdout.write(JSON.stringify(results, null, 2) + EOL)
}
