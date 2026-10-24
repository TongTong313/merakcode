import { expect, test } from "vitest"
import { create, join, leave, load, remember, update } from "../../src/collaboration/store"
import { GroupError } from "../../src/collaboration/board"

test("a group starts with its Merak leader and the seats named up front, announced in one line", async () => {
  const sessionID = `group-${crypto.randomUUID()}`
  await expect(create(sessionID, { leader: { name: "有 空格" } })).rejects.toThrow(GroupError)
  await expect(
    create(sessionID, { leader: { name: "小主" }, seats: [{ name: "小主", product: "claude" }] }),
  ).rejects.toThrow(/already has this name/)
  const group = await create(sessionID, {
    leader: { name: "小主", duty: "负责分派，也可以自己干活" },
    seats: [
      { name: "小红", role: "产品经理", duty: "负责登录，不改支付", product: "claude" },
      { name: "abc", product: "codex" },
    ],
  })
  expect(group.seats.map((seat) => [seat.name, seat.product, seat.leader])).toEqual([
    ["小主", "merak", true],
    ["小红", "claude", false],
    ["abc", "codex", false],
  ])
  expect(group.seats[2]).toMatchObject({ role: "", duty: "" })
  expect(group.events).toEqual([expect.objectContaining({ kind: "join", names: ["小红", "abc"] })])
})

test("two seats of one product keep their own private session across rename, and the leader cannot leave", async () => {
  const sessionID = `group-${crypto.randomUUID()}`
  const group = await create(sessionID, { leader: { name: "小主" } })
  const withRed = await join(sessionID, { name: "小红", role: "产品经理", product: "claude" })
  const withGang = await join(sessionID, { name: "小刚", product: "claude" })
  expect(withGang.seats.filter((seat) => seat.product === "claude")).toHaveLength(2)
  await expect(join(sessionID, { name: "小红", product: "codex" })).rejects.toThrow(/already has this name/)
  await expect(join(sessionID, { name: "a@b", product: "codex" })).rejects.toThrow(GroupError)

  const red = withRed.seats.find((seat) => seat.name === "小红")!
  await remember(sessionID, red.id, "sess-keep")
  const renamed = await update(sessionID, red.id, { name: "小芳", role: "", duty: "负责支付" })
  expect(renamed.seats.find((seat) => seat.id === red.id)).toMatchObject({
    name: "小芳",
    role: "",
    duty: "负责支付",
    privateSessionID: "sess-keep",
  })
  expect(renamed.events.at(-1)).toMatchObject({ kind: "rename", names: ["小红", "小芳"] })

  await expect(leave(sessionID, group.seats[0]!.id)).rejects.toThrow(/cannot be removed/)
  const left = await leave(sessionID, withGang.seats.find((seat) => seat.name === "小刚")!.id)
  expect(left.seats.map((seat) => seat.name)).toEqual(["小主", "小芳"])
  expect(left.events.at(-1)).toMatchObject({ kind: "leave", names: ["小刚"] })
  expect((await load(sessionID))?.seats.some((seat) => seat.leader)).toBe(true)
})
