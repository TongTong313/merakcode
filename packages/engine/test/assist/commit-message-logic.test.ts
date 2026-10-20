import { describe, expect, test } from "vitest"
import {
  parseRecentCommits,
  cleanCommitMessage,
  capDiff,
  buildCommitMessagePrompt,
  buildChangeContext,
  composeWorkingTreeDiff,
  parseNameStatus,
  buildChangeSummary,
  pickStyleExamples,
  selectSnippetPaths,
  formatSnippetContent,
  SNIPPET_MAX_CHARS,
} from "@merakcode/engine/server/routes/commit-message-logic"

describe("parseRecentCommits", () => {
  test("splits git log --format=%B%x00 output on NUL", () => {
    expect(parseRecentCommits("a\0b\0c\0")).toEqual(["a", "b", "c"])
  })
  test("keeps inner newlines of multi-line bodies, trims the ends and drops blank entries", () => {
    expect(parseRecentCommits("feat: x\n\n正文说明\0   \0fix: y\n")).toEqual(["feat: x\n\n正文说明", "fix: y"])
  })
  test("returns an empty array for empty input", () => {
    expect(parseRecentCommits("")).toEqual([])
  })
})

describe("cleanCommitMessage", () => {
  test("strips markdown code fences", () => {
    expect(cleanCommitMessage("```\nfeat: x\n```")).toBe("feat: x")
    expect(cleanCommitMessage("```text\nfix: y\n```")).toBe("fix: y")
  })
  test("strips wrapping quotes and backticks", () => {
    expect(cleanCommitMessage('"feat: x"')).toBe("feat: x")
    expect(cleanCommitMessage("`fix: y`")).toBe("fix: y")
  })
  test("strips explanatory prefixes that small models tend to add", () => {
    expect(cleanCommitMessage("Commit message: feat: x")).toBe("feat: x")
    expect(cleanCommitMessage("Here is the commit message:\nfeat: x")).toBe("feat: x")
    expect(cleanCommitMessage("Here's the commit message:\nfeat: z")).toBe("feat: z")
    expect(cleanCommitMessage("提交信息：fix: y")).toBe("fix: y")
  })
  test("collapses runs of 3+ blank lines in the body into one", () => {
    expect(cleanCommitMessage("feat: x\n\n\n\n正文")).toBe("feat: x\n\n正文")
  })
})

describe("capDiff", () => {
  test("returns input under the limit unchanged", () => {
    expect(capDiff("small diff", 100)).toBe("small diff")
  })
  test("truncates oversized input to the limit and appends a truncated marker", () => {
    const out = capDiff("x".repeat(50), 10)
    expect(out.startsWith("x".repeat(10))).toBe(true)
    expect(out).toContain("truncated")
    expect(out.length).toBeLessThan(50)
  })
  test("applies the default limit used by the endpoint to oversized diffs", () => {
    const out = capDiff("y".repeat(20000))
    expect(out).toContain("truncated")
    expect(out.length).toBeLessThan(20000)
  })
})

describe("composeWorkingTreeDiff", () => {
  test("returns an empty string when both tracked and untracked changes are empty (means no changes)", () => {
    expect(composeWorkingTreeDiff("", "")).toBe("")
    expect(composeWorkingTreeDiff("  \n", "\n")).toBe("")
  })
  test("returns tracked changes unchanged when there are no untracked files", () => {
    expect(composeWorkingTreeDiff("diff --git a/x b/x", "")).toBe("diff --git a/x b/x")
  })
  test("lists untracked files when they are the only change, so it is not reported as empty", () => {
    const out = composeWorkingTreeDiff("", "a.ts\nb.ts\n")
    expect(out).toContain("a.ts")
    expect(out).toContain("b.ts")
    expect(out).toMatch(/untracked/i)
  })
  test("combines tracked changes and untracked files", () => {
    const out = composeWorkingTreeDiff("DIFF_BODY", "new.ts\n")
    expect(out).toContain("DIFF_BODY")
    expect(out).toContain("new.ts")
  })
})

describe("parseNameStatus", () => {
  test("counts added, modified and deleted files from git diff --name-status", () => {
    const raw = ["D\tsrc/removed.ts", "M\tREADME.md", "A\tnew.ts"].join("\n")
    expect(parseNameStatus(raw)).toEqual({ added: 1, modified: 1, deleted: 1 })
  })
})

describe("buildChangeSummary", () => {
  test("deleted counts files from name-status, not deleted lines from stat", () => {
    const summary = buildChangeSummary({
      source: "staged",
      nameStatus: "D\tsrc/old.ts\nM\tREADME.md",
      untracked: "",
    })
    expect(summary).toContain("1 deleted")
    expect(summary).toContain("1 modified")
    expect(summary).not.toMatch(/50 deleted/)
  })
})

describe("pickStyleExamples", () => {
  test("returns the single most complete example when the style is consistent", () => {
    const examples = pickStyleExamples([
      "feat: add login",
      "fix: typo",
      "feat: add dashboard\n\n- add chart\n- add filters",
    ])
    expect(examples).toEqual(["feat: add dashboard\n\n- add chart\n- add filters"])
  })

  test("returns two representative examples when styles are mixed", () => {
    const examples = pickStyleExamples(["feat: plain", "[JIRA-1] fix legacy", "feat(ui): scoped"])
    expect(examples).toEqual(["feat: plain", "[JIRA-1] fix legacy"])
  })
})

describe("formatSnippetContent", () => {
  test("marks content over a custom character limit as truncated", () => {
    expect(formatSnippetContent("a".repeat(600), { maxChars: 500 })).toBe("a".repeat(500) + "\n…(truncated)")
  })

  test("defaults the character limit to SNIPPET_MAX_CHARS", () => {
    const out = formatSnippetContent("a".repeat(SNIPPET_MAX_CHARS + 50))
    expect(out).toBe("a".repeat(SNIPPET_MAX_CHARS) + "\n…(truncated)")
  })

  test("marks a prefix-read large file as file content truncated without a second truncated marker", () => {
    const out = formatSnippetContent("a".repeat(SNIPPET_MAX_CHARS + 50), { fileTruncated: true })
    expect(out).toBe("a".repeat(SNIPPET_MAX_CHARS) + "\n…(file content truncated)")
    expect(out.match(/truncated/g)?.length).toBe(1)
  })

  test("still marks a truncated file whose snippet is under the character limit", () => {
    expect(formatSnippetContent("short", { fileTruncated: true })).toBe("short\n…(file content truncated)")
  })
})

describe("selectSnippetPaths", () => {
  test("skips lock files, nul and the like, preferring source files", () => {
    expect(selectSnippetPaths(["bun.lock", "nul", "demo.html", "src/app.ts"])).toEqual(["demo.html", "src/app.ts"])
  })
})

describe("buildChangeContext", () => {
  test("uses only staged changes when present, excluding working and untracked", () => {
    const ctx = buildChangeContext({
      staged: "diff --git a/staged.ts b/staged.ts",
      working: "diff --git a/working.ts b/working.ts",
      untracked: "new.ts\n",
    })
    expect(ctx.source).toBe("staged")
    expect(ctx.empty).toBe(false)
    expect(ctx.diff).toContain("staged.ts")
    expect(ctx.diff).not.toContain("working.ts")
    expect(ctx.diff).not.toContain("new.ts")
  })

  test("falls back to working and untracked changes when nothing is staged", () => {
    const ctx = buildChangeContext({
      staged: "",
      working: "diff --git a/working.ts b/working.ts",
      untracked: "new.ts\n",
    })
    expect(ctx.source).toBe("working")
    expect(ctx.empty).toBe(false)
    expect(ctx.diff).toContain("working.ts")
    expect(ctx.diff).toContain("new.ts")
  })

  test("summarizes many untracked files with a total instead of listing them all", () => {
    const paths = Array.from({ length: 120 }, (_, i) => `file-${i}.html`).join("\n")
    const ctx = buildChangeContext({
      staged: "",
      working: "",
      untracked: paths,
    })
    expect(ctx.summary).toContain("120")
    expect(ctx.diff).toContain("and 100 more")
    expect((ctx.diff.match(/\+ file-/g) ?? []).length).toBe(20)
  })

  test("includes small file content samples in the diff section", () => {
    const ctx = buildChangeContext({
      staged: "",
      working: "",
      untracked: "demo.html\n",
      snippets: [{ path: "demo.html", content: "<!DOCTYPE html>" }],
    })
    expect(ctx.diff).toContain("demo.html")
    expect(ctx.diff).toContain("<!DOCTYPE html>")
  })
})

describe("buildCommitMessagePrompt", () => {
  test("prompt includes the one-shot history example verbatim", () => {
    const examples = pickStyleExamples(["feat: add login\n\n- add form"])
    const { prompt } = buildCommitMessagePrompt({
      context: {
        source: "staged",
        summary: "1 files: 0 added (untracked), 1 modified, 0 deleted",
        diff: "diff --git a/x b/x",
      },
      examples,
    })
    expect(prompt).toContain("feat: add login")
    expect(prompt).toContain("- add form")
    expect(prompt).toMatch(/mimic|example/i)
  })

  test("prompt includes the change summary and diff", () => {
    const { prompt } = buildCommitMessagePrompt({
      context: {
        source: "working",
        summary: "3 files: 2 added (untracked), 1 modified, 0 deleted",
        diff: "MARKER_DIFF_CONTENT",
      },
      examples: [],
    })
    expect(prompt).toContain("MARKER_DIFF_CONTENT")
    expect(prompt).toContain("3 files")
    expect(prompt).toContain("working")
  })

  test("system covers one-shot mimicry, scopeless type: default, content-driven items and a soft length hint", () => {
    const { system } = buildCommitMessagePrompt({
      context: { source: "staged", summary: "s", diff: "d" },
      examples: pickStyleExamples(["feat: x"]),
    })
    expect(system).toMatch(/mimic|example/i)
    expect(system).toContain("type: ")
    expect(system).toMatch(/omit the scope|no clear module/)
    expect(system).toMatch(/body items/)
    expect(system).toMatch(/72/)
    expect(system).toMatch(/File content samples|untracked/)
    expect(system).not.toMatch(/truncate the output/i)
  })

  test("falls back to Conventional Commits guidance without history examples", () => {
    const { system, prompt } = buildCommitMessagePrompt({
      context: { source: "staged", summary: "s", diff: "d" },
      examples: [],
    })
    expect(system).toContain("Conventional Commits")
    expect(prompt).toMatch(/No history examples|fall back/)
    expect(prompt).not.toContain("## Style hints")
  })

  test("follows the UI language: Chinese by default, English for en", () => {
    const context = { source: "staged" as const, summary: "s", diff: "d" }
    const zh = buildCommitMessagePrompt({ context, examples: [] })
    expect(zh.system).toContain("Write the commit message in Chinese")
    expect(zh.prompt).toContain("in Chinese")
    const en = buildCommitMessagePrompt({ context, examples: [], lang: "en" })
    expect(en.system).toContain("Write the commit message in English")
    expect(en.prompt).toContain("in English")
  })
})

describe("cleanCommitMessage output length", () => {
  test("does not truncate a long body", () => {
    const long = "feat: " + "x".repeat(200) + "\n\n- " + "y".repeat(200)
    expect(cleanCommitMessage(long)).toBe(long)
  })
})
