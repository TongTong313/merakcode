/**
 * Builds everything a release needs, locally: archives for every platform, SHA256SUMS, install scripts
 * and the npm packages. Publishing happens only in CI (.github/workflows/release.yml).
 *
 * Usage (in apps/cli): pnpm release
 */
import { execFileSync } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Filesystem } from "@merakcode/util/filesystem"

const dir = path.resolve(import.meta.dirname, "..")
const { version } = await Filesystem.readJson(path.join(dir, "package.json"))
const run = (args: string[]) => execFileSync(process.execPath, args, { cwd: dir, stdio: "inherit" })

if (execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim())
  throw new Error("The working tree has uncommitted changes; commit them before building a release")

// On Windows --import only accepts file:// URLs
const loader = pathToFileURL(path.join(dir, "../../script/node/register.mjs")).href
run(["--import", loader, "script/build.ts", "--archive"])
run(["--import", loader, "script/pack.ts"])
console.log(`\nBuilt v${version} in ${path.join(dir, "dist")}. Publish by pushing the tag v${version}.`)
