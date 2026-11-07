/**
 * The Go module's typecheck: gofmt, then go vet once per target system without cgo, so code that only builds on one
 * system fails on every machine.
 *
 * Usage (in merak): pnpm typecheck
 */
import { spawnSync } from "node:child_process"

const SYSTEMS = ["linux", "darwin", "windows"]

function run(command: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env: { ...process.env, ...env } })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr)
    process.exit(result.status ?? 1)
  }
  return result.stdout
}

const unformatted = run("gofmt", ["-l", "."]).trim()
if (unformatted) {
  console.error(`Not formatted; run gofmt -w on:\n${unformatted}`)
  process.exit(1)
}
for (const system of SYSTEMS) run("go", ["vet", "./..."], { GOOS: system, GOARCH: "amd64", CGO_ENABLED: "0" })
