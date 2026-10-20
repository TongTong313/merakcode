import { describe, expect, test } from "vitest"
import { issues } from "./check-comments"

const kinds = (file: string, text: string) => issues(file, text).map((issue) => `${issue.line}:${issue.kind}`)

describe("issues", () => {
  test("Chinese in line and block comments", () => {
    const text = '// 中文注释\nconst a = 1 /* 块注释 */\n/**\n * 文档注释\n */\nexport const b = "中文字符串"\n'
    expect(kinds("a.ts", text)).toEqual(["1:comment", "2:comment", "3:comment"])
  })

  test("ordinary strings and zh: values are fine", () => {
    expect(kinds("a.ts", 'const text = Text.pick({ zh: "你好", en: "hi" })\nconst s = "中文"\n')).toEqual([])
  })

  test("i18n-allow lets the next line through", () => {
    const text = '// i18n-allow\nconst words = ["测试", "构建"] // 关键词\n// 这一行要报\n'
    expect(kinds("a.ts", text)).toEqual(["3:comment"])
  })

  test("log messages in Chinese", () => {
    expect(kinds("a.ts", 'log.info("启动完成", { a: 1 })\nlog.warn(`失败 ${x}`)\nconsole.log("中文")\n')).toEqual([
      "1:log",
      "2:log",
    ])
  })

  test("test and describe titles in Chinese", () => {
    const text =
      'describe("分组", () => {\n  test("用例", () => {})\n  it.skip("跳过", () => {})\n  test("english", () => {})\n})\n'
    expect(kinds("a.test.ts", text)).toEqual(["1:test", "2:test", "3:test"])
  })

  test("comments in TSX", () => {
    expect(kinds("a.tsx", "const a = <div>{/* 注释 */}</div>\n")).toEqual(["1:comment"])
  })

  test("# comments in shell, PowerShell and YAML files", () => {
    expect(kinds("a.sh", 'echo "中文"\n# 注释\nls # 尾注释\n')).toEqual(["2:comment", "3:comment"])
    expect(kinds("a.yml", "# 说明\nname: ci\n")).toEqual(["1:comment"])
  })
})
