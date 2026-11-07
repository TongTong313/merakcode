/**
 * Builds merak without cgo for every release platform, into dist/<platform>-<arch>/. Platform names match the
 * release packages, merakcode-<platform>-<arch>.
 *
 * Usage (in merak): pnpm build
 */
import { spawnSync } from "node:child_process"
import path from "node:path"

const TARGETS = [
  { platform: "linux", arch: "x64", goos: "linux", goarch: "amd64" },
  { platform: "linux", arch: "arm64", goos: "linux", goarch: "arm64" },
  { platform: "darwin", arch: "x64", goos: "darwin", goarch: "amd64" },
  { platform: "darwin", arch: "arm64", goos: "darwin", goarch: "arm64" },
  { platform: "windows", arch: "x64", goos: "windows", goarch: "amd64" },
  { platform: "windows", arch: "arm64", goos: "windows", goarch: "arm64" },
]

for (const target of TARGETS) {
  const name = target.goos === "windows" ? "merak.exe" : "merak"
  const output = path.join("dist", `${target.platform}-${target.arch}`, name)
  const build = spawnSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", output, "./cmd/merak"], {
    env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: "0" },
    stdio: "inherit",
  })
  if (build.error) throw build.error
  if (build.status !== 0) process.exit(build.status ?? 1)
  console.log(output)
}
