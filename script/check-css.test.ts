import { expect, test } from "vitest"
import { violations } from "./check-css"

test("flags !important in styles (any case, spaces allowed) but not in comments or CSS strings", () => {
  const found = violations([
    { path: "a.css", text: ".a {\n  color: red !important;\n}\n.b { width: 1px ! IMPORTANT }\n" },
    { path: "b.css", text: '/* 不要写 !important */\n.c::after { content: "!important" }\n' },
    { path: "c.tsx", text: 'const style = { color: "red !important" }\n' },
  ])
  expect(found).toEqual([
    { file: "a.css", line: 2 },
    { file: "a.css", line: 4 },
    { file: "c.tsx", line: 1 },
  ])
})
