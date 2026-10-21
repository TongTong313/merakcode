import { expect, test } from "vitest"
import { dangerousGit, splitGitArgs } from "./git-command"

test("quoted text stays one git argument", () => {
  expect(splitGitArgs('commit -m "hello world"')).toEqual(["commit", "-m", "hello world"])
  expect(splitGitArgs("status --porcelain")).toEqual(["status", "--porcelain"])
})

test("reset --hard, clean, force push and deleting a branch ask for confirmation", () => {
  expect(dangerousGit(["reset", "--hard", "HEAD"])).toBe(true)
  expect(dangerousGit(["clean", "-fd"])).toBe(true)
  expect(dangerousGit(["push", "--force"])).toBe(true)
  expect(dangerousGit(["push", "-f"])).toBe(true)
  expect(dangerousGit(["branch", "-D", "old"])).toBe(true)
  expect(dangerousGit(["status"])).toBe(false)
  expect(dangerousGit(["reset", "HEAD"])).toBe(false)
  expect(dangerousGit(["push"])).toBe(false)
  expect(dangerousGit(["branch", "-d", "old"])).toBe(false)
})
