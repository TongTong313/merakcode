import { describe, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { Instance } from "@merakcode/engine/project/instance"
import { Worktree } from "@merakcode/engine/worktree/index"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

describe("Worktree.remove", () => {
  test("continues when git remove exits non-zero after detaching", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = tmp.path
    const name = `remove-regression-${Date.now().toString(36)}`
    const branch = `merakcode/${name}`
    const dir = path.join(root, "..", name)

    await Process.run(["git", "worktree", "add", "--no-checkout", "-b", branch, dir], { cwd: root })
    await Process.run(["git", "reset", "--hard"], { cwd: dir })

    const real = Process.which("git") ?? ""
    expect(real).toBeTruthy()

    const bin = path.join(root, "bin")
    const shim = path.join(bin, "git")
    await fs.mkdir(bin, { recursive: true })
    await Filesystem.write(
      shim,
      [
        "#!/bin/bash",
        `REAL_GIT=${JSON.stringify(real)}`,
        'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
        '  "$REAL_GIT" "$@" >/dev/null 2>&1',
        '  echo "fatal: failed to remove worktree: Directory not empty" >&2',
        "  exit 1",
        "fi",
        'exec "$REAL_GIT" "$@"',
      ].join("\n"),
    )
    await fs.chmod(shim, 0o755)

    const prev = process.env.PATH ?? ""
    process.env.PATH = `${bin}${path.delimiter}${prev}`

    const ok = await (async () => {
      try {
        return await Instance.provide({
          directory: root,
          fn: () => Worktree.remove({ directory: dir }),
        })
      } finally {
        process.env.PATH = prev
      }
    })()

    expect(ok).toBe(true)
    expect(await Filesystem.isFile(dir)).toBe(false)

    const list = (await Process.run(["git", "worktree", "list", "--porcelain"], { cwd: root })).text()
    expect(list).not.toContain(`worktree ${dir}`)

    const ref = await Process.run(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: root,
      nothrow: true,
    })
    expect(ref.exitCode).not.toBe(0)
  })
})
