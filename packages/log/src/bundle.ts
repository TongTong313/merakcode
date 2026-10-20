/**
 * Builds the zip for `merak bug-report` and the desktop "Export diagnostics" menu item. Everything that goes in
 * is passed through sanitize() again, so keys, tokens and prompts stay out even if an old log line has them.
 */
import { lstatSync, readFileSync, readdirSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { arch, platform, release } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js"
import { listRuns, readRecords } from "./inspect"
import { sanitize } from "./record"

export type BundleInput = {
  /** Log root, usually resolveLogRoot() */
  root: string
  /** Where to write the zip */
  out: string
  /** How many recent runs to include (default 10) */
  maxRuns?: number
  /** Extra JSON files by name, e.g. { "doctor.json": checks } */
  extra?: Record<string, unknown>
}

function diagnostics(root: string) {
  const dir = join(root, "diagnostics")
  const names = (() => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  })()
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ file: join(dir, name), time: lstatSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time)
    .slice(0, 20)
    .flatMap(({ file }) => {
      try {
        return [
          {
            name: `diagnostics/${basename(file)}`,
            text: JSON.stringify(sanitize(JSON.parse(readFileSync(file, "utf8"))), null, 2),
          },
        ]
      } catch {
        return []
      }
    })
}

export async function createBundle(input: BundleInput) {
  const runs = listRuns(input.root).slice(0, input.maxRuns ?? 10)
  const logs = runs.flatMap((run) =>
    run.files.map((file) => ({
      name: `logs/${relative(input.root, file).replaceAll("\\", "/")}`,
      text: readRecords(file)
        .map((record) => JSON.stringify(sanitize(record)) + "\n")
        .join(""),
    })),
  )
  const extra = Object.entries(input.extra ?? {}).map(([name, value]) => ({
    name,
    text: JSON.stringify(sanitize(value), null, 2),
  }))
  const files = [...extra, ...logs, ...diagnostics(input.root)]
  const manifest = {
    schema: "merakcode.bug-report.v1",
    created: new Date().toISOString(),
    platform: platform(),
    arch: arch(),
    release: release(),
    runs: runs.map((run) => ({ id: run.id, component: run.component, name: run.name, started: run.started })),
    files: files.map((file) => file.name),
  }
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  await writer.add("manifest.json", new TextReader(JSON.stringify(manifest, null, 2)))
  for (const file of files) await writer.add(file.name, new TextReader(file.text))
  const blob = await writer.close()
  await mkdir(dirname(input.out), { recursive: true })
  await writeFile(input.out, Buffer.from(await blob.arrayBuffer()), { mode: 0o600 })
  return { file: input.out, runs: manifest.runs }
}
