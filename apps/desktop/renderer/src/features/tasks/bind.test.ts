import { expect, test } from "vitest"
import { emptyBoard, type BoardCard, type GroupGroup } from "@merakcode/sdk"
import { groupChoice } from "./bind"

const group = (directory: string): GroupGroup => ({
  id: "g",
  kind: "local",
  name: "Team",
  leader: "leader",
  project: { directory },
})
const card = (status: string, claims: { id: string; status: string }[] = []): BoardCard =>
  ({
    id: status,
    title: status,
    status,
    project: "/work/app",
    claims: claims.map((claim) => ({ ...claim, member: "w", task: status, role: "owner" })),
  }) as unknown as BoardCard
const board = (...cards: BoardCard[]) => {
  const value = emptyBoard()
  for (const item of cards) value.columns[item.status as "open"].push(item)
  return value
}

test("a group in the task's workspace takes it as it is", () => {
  expect(groupChoice("/work/app", group("/work/app/"), board())).toEqual({ moves: false, busy: false })
})

test("a group elsewhere would move to the task's workspace and can do so while nothing is running there", () => {
  expect(groupChoice("/work/app", group("/work/docs"), board(card("open"), card("done")))).toEqual({
    moves: true,
    busy: false,
  })
})

test("a group elsewhere with a running or queued claim cannot move", () => {
  expect(
    groupChoice("/work/app", group("/work/docs"), board(card("running", [{ id: "c", status: "active" }]))),
  ).toEqual({ moves: true, busy: true })
  expect(groupChoice("/work/app", group("/work/docs"), board(card("queued", [{ id: "c", status: "queued" }])))).toEqual(
    { moves: true, busy: true },
  )
  expect(
    groupChoice("/work/app", group("/work/docs"), board(card("review", [{ id: "c", status: "reported" }]))),
  ).toEqual({ moves: true, busy: false })
})

test("a group in the same workspace is never busy for the task, whatever runs in it", () => {
  expect(groupChoice("/work/app", group("/work/app"), board(card("running", [{ id: "c", status: "active" }])))).toEqual(
    { moves: false, busy: false },
  )
})
