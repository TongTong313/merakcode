import { describe, expect, test } from "vitest"
import { Token } from "@merakcode/engine/util/token"

describe("util.token", () => {
  // Binary attachments such as images and PDFs are embedded in messages as base64 data URLs (the standard local-file
  // form of the OpenAI image_url protocol). Providers count their tokens by resolution or page count, not by base64
  // length; estimating base64 as text at 4 chars/token puts a 1MB image near 350k tokens and triggers auto-compaction.
  describe("estimateValue: base64 data URLs are not estimated as text", () => {
    /** Builds a user message with an image attachment, shaped like the file part of ai's convertToModelMessages */
    function imageMessage(base64Length: number, mime = "image/png") {
      return {
        role: "user",
        content: [
          { type: "text", text: "看看这张图" },
          { type: "file", mediaType: mime, filename: "x.png", data: `data:${mime};base64,${"A".repeat(base64Length)}` },
        ],
      }
    }

    test("estimates a 1MB image attachment in the thousands of tokens", () => {
      // 1,398,100 base64 characters ≈ 1MB decoded; estimating it as text would give 349,583
      const tokens = Token.estimateMessages([imageMessage(1_398_100) as any])
      expect(tokens).toBeGreaterThan(1_000)
      expect(tokens).toBeLessThan(5_000)
    })

    test("grows linearly with image size instead of using a flat cost", () => {
      const small = Token.estimateMessages([imageMessage(66_666) as any]) // ~50KB
      const large = Token.estimateMessages([imageMessage(1_398_100) as any]) // ~1MB
      expect(large).toBeGreaterThan(small)
      // 1MB is 20x 50KB; the fixed message text weighs more for the small image, so the ratio is a bit under 20.
      // A threshold of 12 still proves linear growth rather than a flat or quadratic cost.
      expect(large / small).toBeGreaterThan(12)
    })

    test("estimates non-base64 data URLs as text, since the payload is text", () => {
      const textUrl = "data:text/plain,hello world"
      expect(Token.estimateValue(textUrl)).toBe(Token.estimate("data:text/plain,hello world"))
    })

    test("plain text starting with data: is still estimated as text", () => {
      const text = "data: is a useful field name, and so is database"
      expect(Token.estimateValue(text)).toBe(Token.estimate(text))
    })

    test("estimates PDFs and other binary attachments by size too", () => {
      const pdf = `data:application/pdf;base64,${"B".repeat(1_398_100)}`
      const tokens = Token.estimateValue(pdf)
      expect(tokens).toBeGreaterThan(1_000)
      expect(tokens).toBeLessThan(5_000)
    })
  })

  describe("estimate: plain text", () => {
    test("ASCII counts 4 characters per token", () => {
      expect(Token.estimate("hello world")).toBe(3)
    })

    test("CJK counts 1 token per character", () => {
      expect(Token.estimate("你好世界")).toBe(4)
    })

    test("plain objects and arrays are estimated recursively", () => {
      const before = { name: "task", items: ["a", "b", "c"] }
      expect(Token.estimateValue(before)).toBeGreaterThan(0)
    })
  })
})
