/**
 * electron-builder writes latest-mac.yml once per architecture, and the second build would overwrite the first.
 * package.ts keeps each as latest-mac-<arch>.yml and merges them here, so one manifest serves both kinds of Mac
 * (electron-updater picks the file whose name matches the machine).
 */
import { parse, stringify } from "yaml"

type Manifest = {
  version: string
  files: { url: string; [key: string]: unknown }[]
  releaseDate?: string
  [key: string]: unknown
}

export function merge(first: string, second: string): string {
  const a = parse(first) as Manifest
  const b = parse(second) as Manifest
  if (a.version !== b.version)
    throw new Error(`Update manifests are for different versions: ${a.version} and ${b.version}`)
  const files = [...a.files, ...b.files.filter((file) => !a.files.some((item) => item.url === file.url))]
  const releaseDate = [a.releaseDate, b.releaseDate]
    .filter((date): date is string => !!date)
    .sort()
    .at(-1)
  return stringify({ ...a, files, ...(releaseDate ? { releaseDate } : {}) })
}
