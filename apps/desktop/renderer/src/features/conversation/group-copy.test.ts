import { beforeEach, expect, test } from "vitest"
import type { AgentAgent, GroupMember } from "@merakcode/sdk"
import { setLocale } from "../../i18n"
import { copyGroup } from "./group-copy"

beforeEach(() => setLocale("zh"))

const agent = (id: string, name: string): AgentAgent => ({
  id,
  name,
  summary: "",
  duties: "",
  toolPool: "worker.default",
  model: { provider: "", model: "" },
})
const member = (id: string, name: string, agentId: string, agentRole: string): GroupMember => ({
  id,
  name,
  group: "old",
  kind: "agent",
  agent: agentId,
  agentRole,
  status: "idle",
})

test("a copy keeps the group's name and its Workers, and leaves out the Leader, people and agents that are gone", () => {
  const copy = copyGroup(
    {
      name: "登录小组",
      members: [
        { id: "me", name: "You", group: "old", kind: "human", role: "owner", status: "idle" },
        member("leader", "小主", "builtin-merakcode", "leader"),
        member("a", "小红", "writer", "worker"),
        member("b", "小刚", "deleted-agent", "worker"),
        member("c", "小王", "reviewer", "worker"),
      ],
    },
    [agent("builtin-merakcode", "MerakCode"), agent("writer", "写手"), agent("reviewer", "审核")],
  )
  expect(copy.name).toBe("登录小组")
  expect(copy.workers).toEqual(["writer", "reviewer"])
  expect(copy.skipped).toEqual(["小刚"])
})

test("an agent that is in the group twice is chosen once", () => {
  const copy = copyGroup(
    { name: "两个写手", members: [member("a", "甲", "writer", "worker"), member("b", "乙", "writer", "worker")] },
    [agent("writer", "写手")],
  )
  expect(copy.workers).toEqual(["writer"])
  expect(copy.skipped).toEqual([])
})
