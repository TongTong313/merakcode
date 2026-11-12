import { expect, test } from "vitest"
import type { GroupMember } from "@merakcode/sdk"
import { memberName, nameFor, nameProblem } from "./roster"

const member = (name: string): GroupMember => ({ id: name, group: "g", kind: "agent", name, status: "idle" })

test("an agent's name becomes a name people can @: spaces turn into hyphens and @ is dropped", () => {
  expect(memberName("Claude Code", "Worker")).toBe("Claude-Code")
  expect(memberName("  @Ann  Lee ", "Worker")).toBe("Ann-Lee")
  expect(memberName("@", "Worker")).toBe("Worker")
})

test("a second agent with the same name gets a number, whatever the case", () => {
  expect(nameFor("Worker", [member("Worker")])).toBe("Worker2")
  expect(nameFor("worker", [member("Worker"), member("worker2")])).toBe("worker3")
  expect(nameFor("Poet", [member("Worker")])).toBe("Poet")
})

test("a name with a space or an @, an empty one and a taken one are refused", () => {
  expect(nameProblem("Poet", ["Worker"])).toBeUndefined()
  expect(nameProblem("", [])).toBeTruthy()
  expect(nameProblem("Two words", [])).toBeTruthy()
  expect(nameProblem("@Poet", [])).toBeTruthy()
  expect(nameProblem("worker", ["Worker"])).toBeTruthy()
})
