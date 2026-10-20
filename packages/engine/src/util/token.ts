export namespace Token {
  const CHARS_PER_TOKEN = 4
  const CJK = /[\u3400-\u9fff\uf900-\ufaff]/gu
  const NON_ASCII = /[^\x00-\x7f]/gu

  // Images, PDFs and other binary attachments are embedded in messages as data:<mime>;base64,<payload> (the standard
  // OpenAI image_url form for local files that have no public URL). Providers bill them by image resolution or PDF page
  // count, not by base64 length: estimating a 1MB image at 4 characters per token gives ~350k tokens, a gross
  // overestimate that would trigger compaction just for reading one image. Estimate from the decoded byte count
  // instead (1MB ≈ 2k tokens, in line with common multimodal pricing) and lean toward underestimating: provider usage
  // (processor finish-step / overflow error) still catches real overflows, so underestimating only delays compaction
  // by a step while overestimating compacts for nothing.
  const BYTES_PER_BINARY_TOKEN = 500
  const BASE64_DATA_URL = /^data:[^;,]+;base64,/i

  export function estimate(input: string) {
    const text = input || ""
    const cjk = text.match(CJK)?.length ?? 0
    const nonAscii = text.match(NON_ASCII)?.length ?? 0
    const ascii = Math.max(0, text.length - nonAscii)
    const other = Math.max(0, nonAscii - cjk)
    return Math.max(0, Math.round(ascii / CHARS_PER_TOKEN + cjk + other / 2))
  }

  export function estimateValue(input: unknown, seen = new WeakSet<object>()): number {
    if (input === undefined || input === null) return 0
    if (typeof input === "string") {
      // An O(1) prefix check before the regex keeps plain text cheap; a match only needs the length, which avoids
      // running the CJK/NON_ASCII regexes over megabytes of base64
      if (input.startsWith("data:")) {
        const m = input.match(BASE64_DATA_URL)
        if (m) return Math.round(((input.length - m[0].length) * 3) / 4 / BYTES_PER_BINARY_TOKEN)
      }
      return estimate(input)
    }
    if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") {
      return estimate(String(input))
    }
    if (typeof input === "symbol" || typeof input === "function") return 0
    if (input instanceof Date) return estimate(input.toISOString())
    if (input instanceof Uint8Array) return Math.round(input.byteLength / 3)
    if (Array.isArray(input)) {
      if (seen.has(input)) return 0
      seen.add(input)
      return input.reduce<number>((total, item) => total + estimateValue(item, seen) + 1, 2)
    }
    if (typeof input !== "object") return 0
    if (seen.has(input)) return 0
    seen.add(input)

    return Object.entries(input as Record<string, unknown>).reduce<number>((total, [key, value]) => {
      if (value === undefined) return total
      return total + estimate(key) + estimateValue(value, seen) + 2
    }, 2)
  }

  export function estimateMessages(input: readonly unknown[]): number {
    return input.reduce<number>((total, message) => total + estimateValue(message) + 4, 0)
  }
}
