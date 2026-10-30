import { describe, expect, test } from "vitest"
import { MemoryManage } from "./manage"

describe("MemoryManage.pruneIndex", () => {
  const index = [
    "# 记忆索引",
    "",
    "- [用户角色](user/user_role.md) - 数据科学家，关注可观测性",
    "- [用户角色补充](user/user_role_extra.md) - 也懂一点前端",
    "- [测试约定](feedback/feedback_testing.md) - 集成测试必须打真库",
  ].join("\n")

  test("removes the line pointing to the target and keeps the rest unchanged", () => {
    const next = MemoryManage.pruneIndex(index, "user/user_role.md")

    expect(next).not.toContain("user/user_role.md)")
    expect(next).toContain("# 记忆索引")
    expect(next).toContain("user/user_role_extra.md")
    expect(next).toContain("feedback/feedback_testing.md")
  })

  test("keeps sibling entries with the same prefix (user_role does not remove user_role_extra)", () => {
    const next = MemoryManage.pruneIndex(index, "user/user_role.md")
    expect(next).toContain("- [用户角色补充](user/user_role_extra.md)")
  })

  test("matches Windows backslash relative paths (MemoryScan.filename uses backslashes)", () => {
    const next = MemoryManage.pruneIndex(index, "user\\user_role.md")
    expect(next).not.toContain("user/user_role.md)")
    expect(next).toContain("user/user_role_extra.md")
  })

  test("matches index links with a ./ prefix", () => {
    const withDot = "- [用户角色](./user/user_role.md) - hook"
    expect(MemoryManage.pruneIndex(withDot, "user/user_role.md")).toBe("")
  })

  test("returns the index unchanged when the target is not listed", () => {
    expect(MemoryManage.pruneIndex(index, "project/nothing.md")).toBe(index)
  })

  test("returns an empty index unchanged", () => {
    expect(MemoryManage.pruneIndex("", "user/x.md")).toBe("")
  })

  test("removes only the matching line and keeps adjacent blank lines", () => {
    const src = ["# 索引", "", "- [A](user/a.md) - a", "", "- [B](user/b.md) - b", ""].join("\n")
    const next = MemoryManage.pruneIndex(src, "user/a.md")
    expect(next).toBe(["# 索引", "", "", "- [B](user/b.md) - b", ""].join("\n"))
  })
})
