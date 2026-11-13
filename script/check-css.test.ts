import { expect, test } from "vitest"
import { violations } from "./check-css"

test("flags !important in styles (any case, spaces allowed) but not in comments or CSS strings", () => {
  const found = violations([
    { path: "a.css", text: ".a {\n  color: red !important;\n}\n.b { width: 1px ! IMPORTANT }\n" },
    { path: "b.css", text: '/* 不要写 !important */\n.c::after { content: "!important" }\n' },
    { path: "c.tsx", text: 'const style = { color: "red !important" }\n' },
  ])
  expect(found).toEqual([
    { file: "a.css", line: 2, rule: "important" },
    { file: "a.css", line: 4, rule: "important" },
    { file: "c.tsx", line: 1, rule: "important" },
  ])
})

test("flags hexadecimal colors and rgb() in styles outside tokens.css, but accepts tokens", () => {
  const found = violations([
    { path: "src/styles/app.css", text: ".a { color: #fff; }\n.b { color: #1A1A1D; }\n.c { color: #1a1a1d80; }\n" },
    {
      path: "src/styles/panels.css",
      text: ".a { background: rgb(0 0 0 / 0.4); }\n.b { box-shadow: 0 0 1px RGBA(0, 0, 0, 1); }\n",
    },
    {
      path: "src/styles/base.css",
      text: ".a { color: var(--text); background: var(--accent-soft); }\n#root { height: 100%; }\n",
    },
    { path: "src/styles/notes.css", text: '/* #fff and rgb(0 0 0) in a comment */\n.a::after { content: "#fff"; }\n' },
  ])
  expect(found).toEqual([
    { file: "src/styles/app.css", line: 1, rule: "color" },
    { file: "src/styles/app.css", line: 2, rule: "color" },
    { file: "src/styles/app.css", line: 3, rule: "color" },
    { file: "src/styles/panels.css", line: 1, rule: "color" },
    { file: "src/styles/panels.css", line: 2, rule: "color" },
  ])
})

test("tokens.css may define colors; scripts keep their own palettes (terminal, editor themes)", () => {
  const found = violations([
    {
      path: "apps/desktop/renderer/src/styles/tokens.css",
      text: ":root { --bg: #ffffff; --overlay: rgb(9 9 11 / 0.4); }\n",
    },
    { path: "apps/desktop/renderer/src/lib/monaco.ts", text: 'const light = { bg: "#ffffff" }\n' },
  ])
  expect(found).toEqual([])
})
