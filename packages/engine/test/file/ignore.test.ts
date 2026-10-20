import { test, expect } from "vitest"
import { FileIgnore } from "@merakcode/engine/file/ignore"

test("match nested and non-nested", () => {
  expect(FileIgnore.match("node_modules/index.js")).toBe(true)
  expect(FileIgnore.match("node_modules")).toBe(true)
  expect(FileIgnore.match("node_modules/")).toBe(true)
  expect(FileIgnore.match("node_modules/bar")).toBe(true)
  expect(FileIgnore.match("node_modules/bar/")).toBe(true)
})

// Temporary files from atomic writes (file/atomic.ts) must be ignored; otherwise every write or edit makes the watcher
// broadcast an extra create + delete pair and the files briefly show up in the file index.
test("ignores atomic-write temporary files but not regular files", () => {
  expect(FileIgnore.match("src/.foo.ts.mc-tmp-1234-1700000000000-0")).toBe(true)
  expect(FileIgnore.match(".foo.ts.mc-tmp-1-2-3")).toBe(true)
  expect(FileIgnore.match("src/foo.ts")).toBe(false)
  expect(FileIgnore.match("src/tmp-file.ts")).toBe(false)
})
