import { describe, expect, test } from "vitest"
import {
  cjkGrams,
  hasCjk,
  hasEnoughSecondaryMatches,
  MIN_QUERY_LENGTH,
  normalize,
  termScore,
  termsForRank,
  tokenize,
} from "@merakcode/engine/util/text-rank"

describe("text-rank: normalize", () => {
  test("lowercases and collapses non-alphanumerics into single spaces, keeping _ and -", () => {
    expect(normalize("Hello World")).toBe("hello world")
    expect(normalize("a-b:c_d/e")).toBe("a-b c_d e")
    expect(normalize("foo!!!bar###baz")).toBe("foo bar baz")
  })

  test("keeps CJK characters, underscores and hyphens", () => {
    expect(normalize("测试Case")).toBe("测试case")
    expect(normalize("snake_case-name")).toBe("snake_case-name")
  })

  test("collapses repeated whitespace and trims", () => {
    expect(normalize("  a   b  ")).toBe("a b")
  })
})

describe("text-rank: tokenize", () => {
  test("splits on whitespace and common punctuation, dropping empty strings", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"])
    expect(tokenize("a:b_c-d/e")).toEqual(["a", "b", "c", "d", "e"])
  })

  test("returns an empty array for empty or separator-only input", () => {
    expect(tokenize("")).toEqual([])
    expect(tokenize(":-_ ")).toEqual([])
  })
})

describe("text-rank: hasCjk", () => {
  test("false for pure ASCII", () => {
    expect(hasCjk("hello world")).toBe(false)
  })

  test("true when CJK characters are present", () => {
    expect(hasCjk("测试")).toBe(true)
    expect(hasCjk("abc测试")).toBe(true)
  })
})

describe("text-rank: cjkGrams", () => {
  test("keeps a single CJK character as is", () => {
    expect(cjkGrams("测")).toEqual(["测"])
  })

  test("splits a two-character CJK run into a 2-gram", () => {
    expect(cjkGrams("测试")).toEqual(["测试"])
  })

  test("splits a four-character CJK run into 2/3/4-grams", () => {
    expect(cjkGrams("测试用例")).toEqual(["测试", "试用", "用例", "测试用", "试用例", "测试用例"])
  })

  test("extracts only CJK runs and skips ASCII", () => {
    expect(cjkGrams("a测试b")).toEqual(["测试"])
  })
})

describe("text-rank: termScore", () => {
  const tokens = ["database", "config"]

  test("exact: full score when the term equals a token", () => {
    expect(
      termScore({ term: "database", tokens, haystack: "database config", exact: 24, prefix: 18, partial: 12 }),
    ).toBe(24)
  })

  test("prefix: the term and a token are prefixes of each other", () => {
    expect(termScore({ term: "dat", tokens, haystack: "database config", exact: 24, prefix: 18, partial: 12 })).toBe(18)
    expect(
      termScore({ term: "databasex", tokens, haystack: "databasex config", exact: 24, prefix: 18, partial: 12 }),
    ).toBe(18)
  })

  test("partial: the haystack contains the term", () => {
    expect(
      termScore({ term: "base", tokens: ["x"], haystack: "database config", exact: 24, prefix: 18, partial: 12 }),
    ).toBe(12)
  })

  test("returns 0 without any match", () => {
    expect(termScore({ term: "zzz", tokens, haystack: "database config", exact: 24, prefix: 18, partial: 12 })).toBe(0)
  })
})

describe("text-rank: hasEnoughSecondaryMatches", () => {
  test("zero matches are never enough", () => {
    expect(hasEnoughSecondaryMatches(["db", "config"], 0)).toBe(false)
  })

  test("one match is enough for a CJK term", () => {
    expect(hasEnoughSecondaryMatches(["测试"], 1)).toBe(true)
  })

  test("a single term needs length >= 5 and one match", () => {
    expect(hasEnoughSecondaryMatches(["db"], 1)).toBe(false)
    expect(hasEnoughSecondaryMatches(["database"], 1)).toBe(true)
  })

  test("multiple terms need >= min(2, terms.length) matches", () => {
    expect(hasEnoughSecondaryMatches(["db", "config"], 1)).toBe(false)
    expect(hasEnoughSecondaryMatches(["db", "config"], 2)).toBe(true)
  })
})

describe("text-rank: termsForRank", () => {
  test("drops stop words", () => {
    const stop = new Set(["the", "memory"])
    expect(termsForRank("the database memory", stop)).toEqual(["database"])
  })

  test("drops words that are too short, except CJK", () => {
    expect(MIN_QUERY_LENGTH).toBe(2)
    const stop = new Set<string>()
    expect(termsForRank("a db config", stop)).toEqual(["db", "config"])
  })

  test("adds n-grams for CJK queries without duplicates", () => {
    const stop = new Set<string>()
    const terms = termsForRank("数据库", stop)
    expect(terms).toContain("数据库")
    expect(terms).toContain("数据")
    expect(terms).toContain("据库")
    // the three-character query yields its 2-grams and the whole term once each
    expect(new Set(terms).size).toBe(terms.length)
  })

  test("keeps a single CJK character even though it is short", () => {
    const stop = new Set<string>()
    expect(termsForRank("测", stop)).toEqual(["测"])
  })
})
