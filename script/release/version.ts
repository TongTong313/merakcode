/**
 * One version for the whole product: every package.json in the workspace carries the same version.
 *   pnpm release:version 0.2.0         set it everywhere
 *   pnpm release:version 0.2.0-beta.1  a pre-release (published under the "beta" npm tag)
 *   pnpm check:versions                fail if the root version is invalid or any package differs from it
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"

export namespace Version {
  // The pre-release name is the npm tag and the update channel (build.ts, pack.ts, installation), so it must be a
  // lowercase word: npm rejects tags that look like versions, such as "1"
  const PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[a-z]+\.(0|[1-9]\d*))?$/
  const FIELD = /^(\s*"version":\s*")([^"]*)(")/m
  export const EXPECTED = "x.y.z, or x.y.z-name.n for a pre-release such as 0.2.0-beta.1"

  export function valid(version: string) {
    return PATTERN.test(version)
  }

  /** package.json files of the workspace: the root, apps/*, apps/x/*, packages/*, packages/x/* */
  function files(root: string) {
    const children = (dir: string) =>
      existsSync(dir)
        ? readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
            .map((entry) => path.join(dir, entry.name))
        : []
    const dirs = ["apps", "packages"].flatMap((group) => {
      const first = children(path.join(root, group))
      return [...first, ...first.flatMap(children)]
    })
    return [root, ...dirs].map((dir) => path.join(dir, "package.json")).filter((file) => existsSync(file))
  }

  const read = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? ""

  export function set(root: string, version: string): string[] {
    if (!valid(version)) throw new Error(`Not a valid version: ${version} (expected ${EXPECTED})`)
    return files(root).flatMap((file) => {
      const text = readFileSync(file, "utf8")
      if (!FIELD.test(text) || read(file) === version) return []
      writeFileSync(file, text.replace(FIELD, `$1${version}$3`))
      return [file]
    })
  }

  export function check(root: string) {
    const version = read(path.join(root, "package.json"))
    const mismatched = files(root)
      .map((file) => ({ file: path.relative(root, file).replaceAll("\\", "/"), version: read(file) }))
      .filter((item) => item.version !== version)
    return { ok: valid(version) && mismatched.length === 0, valid: valid(version), version, mismatched }
  }
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "..", "..")
  const arg = process.argv[2]
  if (arg === "--check" || !arg) {
    const result = Version.check(root)
    if (!result.valid) console.error(`The root version ${result.version} is not valid (expected ${Version.EXPECTED})`)
    if (result.mismatched.length)
      console.error(
        `Package versions differ from the root (${result.version}):\n` +
          result.mismatched.map((item) => `  ${item.file}: ${item.version}`).join("\n"),
      )
    if (!result.ok) {
      console.error("Run: pnpm release:version <version>")
      process.exitCode = 1
    }
  } else {
    const changed = Version.set(root, arg)
    console.log(
      changed.length
        ? `Set ${arg} in:\n${changed.map((file) => `  ${path.relative(root, file)}`).join("\n")}`
        : `Already ${arg}`,
    )
  }
}
