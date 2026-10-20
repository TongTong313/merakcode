// `merak debug file`: exercise file search, reading, status and listing.
import { EOL } from "os"
import { File } from "../../file/index"
import { Ripgrep } from "../../file/ripgrep"
import { withInstance } from "../bootstrap"

export async function search(args: { query: string }) {
  await withInstance(process.cwd(), async () => {
    const results = await File.search({ query: args.query })
    process.stdout.write(results.join(EOL) + EOL)
  })
}

export async function read(args: { path: string }) {
  await withInstance(process.cwd(), async () => {
    const content = await File.read(args.path)
    process.stdout.write(JSON.stringify(content, null, 2) + EOL)
  })
}

export async function status() {
  await withInstance(process.cwd(), async () => {
    const status = await File.status()
    process.stdout.write(JSON.stringify(status, null, 2) + EOL)
  })
}

export async function list(args: { path: string }) {
  await withInstance(process.cwd(), async () => {
    const files = await File.list(args.path)
    process.stdout.write(JSON.stringify(files, null, 2) + EOL)
  })
}

export async function tree(args: { dir: string }) {
  const files = await Ripgrep.tree({ cwd: args.dir, limit: 200 })
  console.log(JSON.stringify(files, null, 2))
}
