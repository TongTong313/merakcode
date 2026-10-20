import { describe, expect, test } from "vitest"
import { MemoryPath } from "../path"
import { MemoryPrompt } from "../prompt"
import { buildConsolidationPrompt } from "./consolidation-prompt"

describe("buildConsolidationPrompt", () => {
  const memoryDir = "/data/memory/projects/test/"
  const today = "2026-08-13"

  test("includes the date, the directory and the four phases", () => {
    const prompt = buildConsolidationPrompt(memoryDir, "", today)
    expect(prompt).toContain(today)
    expect(prompt).toContain(memoryDir)
    expect(prompt).toContain("Phase 1 - Orient")
    expect(prompt).toContain("Phase 2 - Gather recent signal")
    expect(prompt).toContain("Phase 3 - Consolidate")
    expect(prompt).toContain("Phase 4 - Prune and index")
  })

  test("asks to maintain the four type directories (user/feedback/project/reference)", () => {
    const prompt = buildConsolidationPrompt(memoryDir, "", today)
    for (const type of ["user/", "feedback/", "project/", "reference/"]) {
      expect(prompt).toContain(type)
    }
  })

  test("index line limit matches MemoryPrompt.MAX_ENTRYPOINT_LINES", () => {
    const prompt = buildConsolidationPrompt(memoryDir, "", today)
    expect(prompt).toContain(String(MemoryPrompt.MAX_ENTRYPOINT_LINES))
    expect(prompt).toContain(MemoryPath.ENTRYPOINT_NAME)
  })

  test("appends the Additional Context section when extra is non-empty", () => {
    const extra = "Sessions since the last consolidation:\n- s1\n- s2"
    const prompt = buildConsolidationPrompt(memoryDir, extra, today)
    expect(prompt).toContain("## Additional Context")
    expect(prompt).toContain(extra)
  })

  test("omits the Additional Context section when extra is empty", () => {
    const prompt = buildConsolidationPrompt(memoryDir, "", today)
    expect(prompt).not.toContain("## Additional Context")
  })

  test("asks to merge instead of duplicate and to delete disproven facts", () => {
    const prompt = buildConsolidationPrompt(memoryDir, "", today)
    expect(prompt).toContain("Merge new signal into existing topic files")
    expect(prompt).toContain("Delete disproven facts")
  })
})
