import { describe, expect, test } from "vitest"
import path from "path"
import { EditTool } from "@merakcode/engine/tool/edit"
import { WriteTool } from "@merakcode/engine/tool/write"
import { BashTool, prepareBashCommand } from "@merakcode/engine/tool/bash"
import { FileTime } from "@merakcode/engine/file/time"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { setTimeout as delay } from "node:timers/promises"

// The prompt encourages parallel edit/write across files. Guard two guarantees: different files really run in parallel
// and all land correctly, and same-file conflicts produce an actionable error.

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  kind: "ask" as const,
  abort: AbortSignal.any([]),
  messages: [],
  ruleset: [],
  metadata: () => {},
  ask: async () => {},
  askExternalDirectory: async () => {},
}

// Write the initial content and record a read. Recording right after the write can hit a 1ms skew between the file
// mtime and Date.now() (FileTime.assert requires mtime <= read), so pause first, as a real Read-then-Edit would.
const seed = async (file: string, content: string) => {
  await Filesystem.write(file, content)
  await delay(10)
  FileTime.read(ctx.sessionID, file)
}

describe("parallel edit / write", () => {
  test("editing 3 different files in parallel succeeds with correct content", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await EditTool.init()
        const names = ["a", "b", "c"]
        for (const n of names) {
          await seed(path.join(tmp.path, `${n}.txt`), `hello ${n}`)
        }
        await Promise.all(
          names.map((n) =>
            edit.execute({ filePath: path.join(tmp.path, `${n}.txt`), oldString: "hello", newString: "bye" }, ctx),
          ),
        )
        for (const n of names) {
          expect(await Filesystem.readText(path.join(tmp.path, `${n}.txt`))).toBe(`bye ${n}`)
        }
      },
    })
  })

  test("writing 3 different files in parallel writes all of them", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const write = await WriteTool.init()
        const names = ["x", "y", "z"]
        await Promise.all(
          names.map((n) => write.execute({ filePath: path.join(tmp.path, `${n}.txt`), content: `body ${n}` }, ctx)),
        )
        for (const n of names) {
          expect(await Filesystem.readText(path.join(tmp.path, `${n}.txt`))).toBe(`body ${n}`)
        }
      },
    })
  })

  test("parallel edits to disjoint parts of one file are serialized and both apply", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "a.txt")
        await seed(file, "AAA\nBBB\n")
        const edit = await EditTool.init()
        await Promise.all([
          edit.execute({ filePath: file, oldString: "AAA", newString: "XXX" }, ctx),
          edit.execute({ filePath: file, oldString: "BBB", newString: "YYY" }, ctx),
        ])
        expect(await Filesystem.readText(file)).toBe("XXX\nYYY\n")
      },
    })
  })

  test("parallel edits to the same part of one file fail the second and suggest multi_edit", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "a.txt")
        await seed(file, "AAA BBB")
        const edit = await EditTool.init()
        const results = await Promise.allSettled([
          edit.execute({ filePath: file, oldString: "AAA BBB", newString: "XXX BBB" }, ctx),
          edit.execute({ filePath: file, oldString: "AAA BBB", newString: "AAA YYY" }, ctx),
        ])
        const rejected = results.filter((r) => r.status === "rejected")
        expect(rejected).toHaveLength(1)
        const reason = (rejected[0] as PromiseRejectedResult).reason as Error
        expect(reason.message).toContain("modified by another write in the same turn")
        expect(reason.message).toContain("multi_edit")
        // The edit that got the lock first is kept intact; which one wins depends on scheduling
        const winner = results.findIndex((r) => r.status === "fulfilled")
        expect(await Filesystem.readText(file)).toBe(["XXX BBB", "AAA YYY"][winner])
      },
    })
  })

  test("a missing oldString is not reported as a parallel conflict", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "a.txt")
        await seed(file, "AAA")
        const edit = await EditTool.init()
        const err = (await edit
          .execute({ filePath: file, oldString: "ZZZ", newString: "Q" }, ctx)
          .catch((e) => e)) as Error
        expect(err.message).toContain("Could not find oldString")
        expect(err.message).not.toContain("another write in the same turn")
      },
    })
  })
})

describe("bash write barrier", () => {
  test("a bash command classified as a write blocks parallel edits while it runs", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "a.txt")
        await seed(file, "AAA")
        const bash = await BashTool.init()
        const edit = await EditTool.init()
        // ping is not on the read-only allowlist, so it counts as a write and holds the barrier while it runs.
        // It exists on every platform, runs long enough and changes no files; this checks the barrier, not conflicts.
        const slow = process.platform === "win32" ? "ping -n 3 127.0.0.1" : "ping -c 3 127.0.0.1"
        const running = bash.execute({ command: slow, description: "slow" }, ctx)
        // Wait until the barrier is up before editing. A fixed sleep is flaky: prepareBashCommand loads tree-sitter
        // wasm and reads config, which can take hundreds of ms when other tests run concurrently.
        const deadline = Date.now() + 15_000
        while (FileTime.state().barrier === undefined) {
          if (Date.now() > deadline) throw new Error("bash did not raise the write barrier in time")
          await delay(5)
        }
        let edited = false
        const editing = edit.execute({ filePath: file, oldString: "AAA", newString: "BBB" }, ctx).then(() => {
          edited = true
        })
        // The edit must not land while the barrier is up. Don't compare completion order: the barrier lifts when the
        // process exits, but bash then compresses and truncates output, so the edit may well resolve first.
        let samples = 0
        while (FileTime.state().barrier !== undefined) {
          expect(edited).toBe(false)
          samples++
          await delay(10)
        }
        // Make sure the loop above actually observed the barrier window
        expect(samples).toBeGreaterThan(10)
        await Promise.all([running, editing])
        expect(await Filesystem.readText(file)).toBe("BBB")
      },
    })
  }, 30_000)
})

describe("bash read-only classification (decides whether to take the write barrier)", () => {
  const check = async (command: string) => {
    let readOnly = false
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        readOnly = (await prepareBashCommand({ command, description: "t" }, ctx)).readOnly
      },
    })
    return readOnly
  }

  test.each([
    "git status",
    "git diff --stat",
    "git log --oneline -n 5",
    "ls -la",
    "cat foo.txt",
    "grep -rn pattern .",
    "echo hello",
    "git status && git diff",
  ])("read-only: %s", async (command) => {
    expect(await check(command)).toBe(true)
  })

  test.each([
    "rm -rf foo",
    "mv a b",
    "sed -i s/a/b/ foo.txt",
    "npm install",
    "git commit -m x",
    "git checkout main",
    "python script.py",
    "echo hi > out.txt",
    "cat a.txt >> b.txt",
    "git status > out.txt",
    "find . -name '*.tmp' -delete",
    // A write later in a pipeline is missed if only the first command name is checked
    "grep foo a.txt | tee out.txt",
    // Writes inside command substitution count too
    "echo $(rm -rf foo)",
    // git subcommands that both read and write are not allowlisted
    "git symbolic-ref HEAD refs/heads/main",
  ])("write: %s", async (command) => {
    expect(await check(command)).toBe(false)
  })
})
