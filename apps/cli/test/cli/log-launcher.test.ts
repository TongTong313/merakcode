import { expect, test } from "vitest"
import { join } from "node:path"
import { readdir } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"
import { RunTracker } from "@merakcode/log/node"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

for (const custom of [true, false]) {
  test.skipIf(process.platform !== "win32")(
    `Windows launcher dispatches override once, drains stderr and diagnoses next launch (${custom ? "explicit root" : "XDG data root"})`,
    async () => {
      await using tmp = await tmpdir()
      const root = custom ? join(tmp.path, "logs") : join(tmp.path, "merakcode", "log")
      // Reproduce the published CommonJS package, not the ESM source workspace.
      const launcher = join(tmp.path, "bin", "merakcode")
      await Filesystem.write(join(tmp.path, "package.json"), JSON.stringify({ name: "merakcode", type: "commonjs" }))
      await Filesystem.copy(join(import.meta.dirname, "../../bin/merak"), launcher)
      await Filesystem.copy(join(import.meta.dirname, "../../bin/cli-name.cjs"), join(tmp.path, "bin", "cli-name.cjs"))
      await Filesystem.copy(
        join(import.meta.dirname, "../../node_modules/@merakcode/log/src/crash-evidence.cjs"),
        join(tmp.path, "bin", "crash-evidence.cjs"),
      )
      const child = Process.spawn(
        [
          "node",
          launcher,
          "-e",
          'process.stdout.write("once"); process.stderr.write("FATAL ERROR: Reached heap limit\\n----- Native stack trace -----\\nOverlay.dll\\nBearer secret-value"); process.exit(17)',
        ],
        {
          env: {
            ...process.env,
            MERAKCODE_BIN_PATH: process.execPath,
            XDG_DATA_HOME: tmp.path,
            MERAKCODE_LOG_ROOT: custom ? root : "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(17)
      expect(stdout).toBe("once")
      expect(stderr).toContain("Overlay.dll")
      const evidence = join(root, ".state", "crash-evidence")
      const files = await readdir(evidence)
      expect(files).toHaveLength(1)
      expect(await Filesystem.readText(join(evidence, files[0]!))).not.toContain("secret-value")
      const tracker = RunTracker.start({ root, component: "cli" })
      expect(tracker.diagnostics).toHaveLength(1)
      expect(await Filesystem.readText(tracker.diagnostics[0]!)).toContain("native_runtime_crash")
      tracker.close()
    },
  )
}
