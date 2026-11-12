import { expect, test } from "vitest"
import type { GroupMember } from "@merakcode/sdk"
import { recipientsOf } from "./group-page"

const member = (id: string, name: string): GroupMember => ({
  id,
  name,
  group: "g",
  kind: "agent",
  agentRole: "worker",
  status: "idle",
})
const members = [member("a", "Ann"), member("b", "Ann-Lee"), member("c", "小红")]

test("an @ name picks its member, the longest name first, and the member chosen with the button stays", () => {
  expect(recipientsOf("@Ann-Lee please look", members, [])).toEqual(["b"])
  expect(recipientsOf("hello @Ann, and @小红：看一下", members, ["c"])).toEqual(["c", "a"])
  expect(recipientsOf("mail me at x@Ann.com", members, [])).toEqual([])
  expect(recipientsOf("no mention", members, ["a"])).toEqual(["a"])
  expect(recipientsOf("@Ann", [], [])).toEqual([])
})
