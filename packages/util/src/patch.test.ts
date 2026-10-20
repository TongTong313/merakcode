import { expect, test } from "vitest"
import { Patch } from "./patch"

// A patch produced by diff 9: like git, paths with backslashes or non-ASCII characters are quoted and octal-escaped
const generated = [
  "Index: C:\\proj\\说明.md",
  "===================================================================",
  '--- "C:\\\\proj\\\\\\350\\257\\264\\346\\230\\216.md"',
  '+++ "C:\\\\proj\\\\\\350\\257\\264\\346\\230\\216.md"',
  "@@ -1,2 +1,2 @@",
  " 标题",
  "-旧内容",
  "+新内容",
  "",
].join("\n")

test("keeps only the hunks, dropping the header with escaped paths", () => {
  expect(Patch.hunks(generated)).toBe(["@@ -1,2 +1,2 @@", " 标题", "-旧内容", "+新内容", ""].join("\n"))
})

test("returns the patch unchanged when it has no hunks (e.g. a new empty file)", () => {
  const empty =
    "Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n"
  expect(Patch.hunks(empty)).toBe(empty)
})
