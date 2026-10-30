import { describe, expect, test } from "vitest"
import { SessionReference } from "./reference"

describe("SessionReference.parse", () => {
  test("extracts the session id from session://", () => {
    expect(SessionReference.parse("session://ses_abc123")).toBe("ses_abc123")
  })

  test("accepts session: without slashes (URLs allow an opaque path)", () => {
    expect(SessionReference.parse("session:ses_abc123")).toBe("ses_abc123")
  })

  test("rejects other schemes so @file references never take the past-chat path", () => {
    expect(SessionReference.parse("file:///repo/a.ts")).toBeUndefined()
    expect(SessionReference.parse("data:text/plain;base64,QQ==")).toBeUndefined()
    expect(SessionReference.parse("https://example.com/ses_x")).toBeUndefined()
  })

  test("returns undefined for a missing id or invalid URL", () => {
    expect(SessionReference.parse("session://")).toBeUndefined()
    expect(SessionReference.parse("session:")).toBeUndefined()
    expect(SessionReference.parse("")).toBeUndefined()
    expect(SessionReference.parse("ses_abc123")).toBeUndefined()
  })

  test("ignores query strings and trailing slashes that clients may add", () => {
    expect(SessionReference.parse("session://ses_abc123/")).toBe("ses_abc123")
    expect(SessionReference.parse("session://ses_abc123?title=x")).toBe("ses_abc123")
  })
})

describe("SessionReference.wrap", () => {
  const wrap = (body: string, maxBytes?: number) =>
    SessionReference.wrap({ sessionID: "ses_abc", title: "重构鉴权", body, maxBytes })

  test("includes the session id, title and body", () => {
    const text = wrap("## 用户\n\n怎么做\n")
    expect(text).toContain("ses_abc")
    expect(text).toContain("重构鉴权")
    expect(text).toContain("怎么做")
  })

  test("adds no truncation notice within budget", () => {
    expect(wrap("短正文")).not.toContain(SessionReference.TRUNCATED_MARK)
  })

  // The title is in the envelope and outside the budget; the body is filled from the end, dropping earlier lines.
  test("keeps the title and the end of the body over budget", () => {
    const body = Array.from({ length: 200 }, (_, i) => `第 ${i} 行内容`).join("\n")
    const text = wrap(body, 200)
    expect(text).toContain("重构鉴权")
    expect(text).toContain(SessionReference.TRUNCATED_MARK)
    expect(text).toContain("第 199 行内容")
    expect(text).not.toContain("第 0 行内容")
  })

  // The earlier part becomes a summary outside the 60KB body budget; recent turns are still taken from the end.
  test("over budget with a head summary, keeps the title, summary and verbatim tail", () => {
    const body = Array.from({ length: 200 }, (_, i) => `第 ${i} 行内容`).join("\n")
    const text = SessionReference.wrap({
      sessionID: "ses_abc",
      title: "重构鉴权",
      body,
      maxBytes: 200,
      headSummary: "早段结论：先把 token 校验拆出去",
    })
    expect(text).toContain("重构鉴权")
    expect(text).toContain("<past-chat-summary>")
    expect(text).toContain("早段结论：先把 token 校验拆出去")
    expect(text).toContain("第 199 行内容")
    expect(text).not.toContain("第 0 行内容")
  })

  test("truncates by line and never splits a multi-byte character", () => {
    const body = Array.from({ length: 50 }, () => "中文内容行").join("\n")
    const text = wrap(body, 100)
    expect(text).not.toContain("\uFFFD")
    // Every kept line must be the complete line, with no partial characters.
    const kept = text.split("\n").filter((line) => line.includes("中文"))
    expect(kept.every((line) => line === "中文内容行")).toBe(true)
  })

  test("skips a last line that alone exceeds the budget and keeps earlier lines that fit", () => {
    const body = ["早段铺垫", "近段结论", "超长".repeat(100)].join("\n")
    const text = wrap(body, 20)
    expect(text).toContain("重构鉴权")
    expect(text).toContain(SessionReference.TRUNCATED_MARK)
    expect(text).toContain("近段结论")
    expect(text).not.toContain("早段铺垫")
    expect(text).not.toContain("超长超长")
  })

  test("still adds the notice when a single line exceeds the budget", () => {
    const text = wrap("超长单行".repeat(100), 10)
    expect(text).toContain(SessionReference.TRUNCATED_MARK)
    expect(text).toContain("ses_abc")
  })

  test("produces a complete block for an empty body", () => {
    const text = wrap("")
    expect(text).toContain("ses_abc")
    expect(text).toContain("重构鉴权")
  })
})
