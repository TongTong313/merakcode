import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import { ContextAttach } from "@merakcode/engine/agent/context/context-attach"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { FileTime } from "@merakcode/engine/infra/file/time"
import { Flag } from "@merakcode/engine/infra/flag/flag"
import { tmpdir } from "../fixture/fixture"
import { isolate } from "../rule/isolate"
import { Filesystem } from "@merakcode/util/filesystem"

function item(overrides: Partial<ContextAttach.Item> = {}): ContextAttach.Item {
  return {
    layer: ContextAttach.Layer.AGENTS_MD,
    filepath: "/tmp/AGENTS.md",
    content: "Instructions from: /tmp/AGENTS.md\n# Root",
    reason: "nested-agents",
    ...overrides,
  }
}

const NOTE = ContextAttach.PRECEDENCE_NOTE

describe("ContextAttach.render", () => {
  test("returns empty string when there is nothing to attach", () => {
    expect(ContextAttach.render([])).toBe("")
  })

  // Appended to read tool results, so any format change alters what the model sees; pinned byte for byte.
  test("wraps a single item in system-reminder", () => {
    expect(ContextAttach.render([item()])).toBe(
      `\n\n<system-reminder>\n${NOTE}\n\nInstructions from: /tmp/AGENTS.md\n# Root\n</system-reminder>`,
    )
  })

  test("joins multiple items with a blank line", () => {
    const rendered = ContextAttach.render([item({ content: "first" }), item({ content: "second" })])
    expect(rendered).toBe(`\n\n<system-reminder>\n${NOTE}\n\nfirst\n\nsecond\n</system-reminder>`)
  })

  test("orders items from general to specific by layer", () => {
    const rendered = ContextAttach.render([
      item({ layer: ContextAttach.Layer.NATIVE_RULE, content: "specific" }),
      item({ layer: ContextAttach.Layer.GLOBAL_USER, content: "general" }),
    ])
    expect(rendered).toBe(`\n\n<system-reminder>\n${NOTE}\n\ngeneral\n\nspecific\n</system-reminder>`)
  })

  test("keeps discovery order within the same layer", () => {
    const rendered = ContextAttach.render([item({ content: "a" }), item({ content: "b" }), item({ content: "c" })])
    expect(rendered).toBe(`\n\n<system-reminder>\n${NOTE}\n\na\n\nb\n\nc\n</system-reminder>`)
  })

  // Precedence by concatenation order is only probabilistic; without the explicit rule the model has to guess when
  // parent and child directories conflict.
  test("always states the precedence rule", () => {
    expect(ContextAttach.render([item()])).toContain("follow the one that appears later")
  })

  test("stops appending once the byte budget is exhausted", () => {
    const big = "x".repeat(ContextAttach.MAX_ATTACH_BYTES)
    const rendered = ContextAttach.render([item({ content: big }), item({ content: "dropped" })])
    // includes instead of toContain, so a failure doesn't dump the 32KB filler into the diff
    expect(rendered.includes(big)).toBe(true)
    expect(rendered.includes("dropped")).toBe(false)
  })
})

describe("ContextAttach registry", () => {
  afterEach(() => {
    ContextAttach.unregister("stub")
  })

  test("ships the AGENTS.md provider by default", () => {
    expect(ContextAttach.registered().map((p) => p.id)).toContain("agents-md")
  })

  test("appends a new provider and includes its items", async () => {
    ContextAttach.register({
      id: "stub",
      async forFile() {
        return [item({ layer: ContextAttach.Layer.DYNAMIC, filepath: "/tmp/stub", content: "stub", reason: "glob" })]
      },
    })

    await isolate(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Filesystem.write(path.join(dir, "file.ts"), "const x = 1")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const items = await ContextAttach.forFile({
            filepath: path.join(tmp.path, "file.ts"),
            trigger: "read",
            messageID: "msg-stub",
            messages: [],
          })
          expect(items.map((i) => i.filepath)).toEqual(["/tmp/stub"])
        },
      })
    })
  })

  test("replaces a provider registered under the same id", () => {
    const before = ContextAttach.registered().length
    ContextAttach.register({
      id: "stub",
      async forFile() {
        return []
      },
    })
    ContextAttach.register({
      id: "stub",
      async forFile() {
        return []
      },
    })
    expect(ContextAttach.registered().length).toBe(before + 1)
  })

  test("registered() returns a copy that cannot mutate the registry", () => {
    const snapshot = ContextAttach.registered()
    const before = snapshot.length
    snapshot.push({
      id: "stub",
      async forFile() {
        return []
      },
    })
    expect(ContextAttach.registered().length).toBe(before)
  })
})

describe("ContextAttach.forFile", () => {
  test("attaches nested AGENTS.md tagged with layer and reason", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Filesystem.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
          await Filesystem.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const items = await ContextAttach.forFile({
            filepath: path.join(tmp.path, "subdir", "nested", "file.ts"),
            trigger: "read",
            messageID: "msg-nested",
            messages: [],
          })
          expect(items.length).toBe(1)
          expect(items[0].filepath).toBe(path.join(tmp.path, "subdir", "AGENTS.md"))
          expect(items[0].layer).toBe(ContextAttach.Layer.AGENTS_MD)
          expect(items[0].reason).toBe("nested-agents")
        },
      })
    })
  })

  test("does not attach the same file twice within one message", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Filesystem.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
          await Filesystem.write(path.join(dir, "subdir", "a.ts"), "const a = 1")
          await Filesystem.write(path.join(dir, "subdir", "b.ts"), "const b = 1")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const first = await ContextAttach.forFile({
            filepath: path.join(tmp.path, "subdir", "a.ts"),
            trigger: "read",
            messageID: "msg-dedupe",
            messages: [],
          })
          const second = await ContextAttach.forFile({
            filepath: path.join(tmp.path, "subdir", "b.ts"),
            trigger: "read",
            messageID: "msg-dedupe",
            messages: [],
          })
          expect(first.length).toBe(1)
          expect(second).toEqual([])

          ContextAttach.clear("msg-dedupe")
          const afterClear = await ContextAttach.forFile({
            filepath: path.join(tmp.path, "subdir", "b.ts"),
            trigger: "read",
            messageID: "msg-dedupe",
            messages: [],
          })
          expect(afterClear.length).toBe(1)
        },
      })
    })
  })

  // @directory and list triggers pass the directory itself, so its own AGENTS.md must be included.
  test("directory triggers include the directory's own instructions", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Filesystem.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const items = await ContextAttach.forFile({
            filepath: path.join(tmp.path, "subdir"),
            trigger: "list",
            directory: true,
            messageID: "msg-list",
            messages: [],
          })
          expect(items.map((i) => i.filepath)).toEqual([path.join(tmp.path, "subdir", "AGENTS.md")])
        },
      })
    })
  })
})

describe("ContextAttach.forSearchHits", () => {
  test("attaches instructions for the directories of the matched files", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Filesystem.write(path.join(dir, "one", "AGENTS.md"), "# One")
          await Filesystem.write(path.join(dir, "one", "a.ts"), "hit")
          await Filesystem.write(path.join(dir, "two", "AGENTS.md"), "# Two")
          await Filesystem.write(path.join(dir, "two", "b.ts"), "hit")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const items = await ContextAttach.forSearchHits({
            files: [path.join(tmp.path, "one", "a.ts"), path.join(tmp.path, "two", "b.ts")],
            messageID: "msg-search",
            messages: [],
          })
          expect(items.map((i) => i.filepath).sort()).toEqual(
            [path.join(tmp.path, "one", "AGENTS.md"), path.join(tmp.path, "two", "AGENTS.md")].sort(),
          )
          expect(items.every((i) => i.reason === "nested-agents")).toBe(true)
        },
      })
    })
  })

  // One grep can hit dozens of directories; attaching each would drown the search results.
  test("keeps only the most-hit directories", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          for (const name of ["d1", "d2", "d3", "d4"]) {
            await Filesystem.write(path.join(dir, name, "AGENTS.md"), `# ${name}`)
            await Filesystem.write(path.join(dir, name, "x.ts"), "hit")
          }
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const items = await ContextAttach.forSearchHits({
            // d1 has the most hits, the others one each
            files: [
              path.join(tmp.path, "d1", "x.ts"),
              path.join(tmp.path, "d1", "y.ts"),
              path.join(tmp.path, "d2", "x.ts"),
              path.join(tmp.path, "d3", "x.ts"),
              path.join(tmp.path, "d4", "x.ts"),
            ],
            messageID: "msg-search-limit",
            messages: [],
          })
          expect(items.length).toBe(ContextAttach.SEARCH_DIRECTORY_LIMIT)
          expect(items.map((i) => i.filepath)).toContain(path.join(tmp.path, "d1", "AGENTS.md"))
        },
      })
    })
  })
})

describe("ContextAttach.reaffirm", () => {
  const flag = Flag as { MERAKCODE_DISABLE_INSTRUCTION_REAFFIRM: boolean }
  const original = flag.MERAKCODE_DISABLE_INSTRUCTION_REAFFIRM

  afterEach(() => {
    flag.MERAKCODE_DISABLE_INSTRUCTION_REAFFIRM = original
  })

  async function fixture() {
    return tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "AGENTS.md"), "# RootOnly")
        await Filesystem.write(path.join(dir, "sub", "AGENTS.md"), "# SubOnly")
        await Filesystem.write(path.join(dir, "sub", "a.ts"), "const a = 1")
      },
    })
  }

  test("stays silent while the flag is off", async () => {
    flag.MERAKCODE_DISABLE_INSTRUCTION_REAFFIRM = true
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        FileTime.read("ses-off", path.join(tmp.path, "sub", "a.ts"))
        expect(await ContextAttach.reaffirm("ses-off")).toEqual([])
      },
    })
  })

  test("re-sends instructions for directories touched this session", async () => {
    flag.MERAKCODE_DISABLE_INSTRUCTION_REAFFIRM = false
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        FileTime.read("ses-on", path.join(tmp.path, "sub", "a.ts"))
        const blocks = await ContextAttach.reaffirm("ses-on")
        expect(blocks.length).toBe(1)
        expect(blocks[0]).toContain(ContextAttach.PRECEDENCE_NOTE)
        expect(blocks[0]).toContain("# SubOnly")
        // system() already injects the project root instructions every turn.
        expect(blocks[0]).not.toContain("# RootOnly")
      },
    })
  })

  test("stays silent when nothing has been touched", async () => {
    flag.MERAKCODE_DISABLE_INSTRUCTION_REAFFIRM = false
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await ContextAttach.reaffirm("ses-empty")).toEqual([])
      },
    })
  })
})
