import { expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Server } from "@merakcode/engine/app/server/server"
import { Session } from "@merakcode/engine/agent/session/index"
import { remember } from "@merakcode/engine/app/task/collaboration/store"
import { tmpdir } from "../fixture/fixture"
import { configureConnections } from "../fixture/agent-connections"

async function post(app: ReturnType<typeof Server.App>, directory: string, body: unknown) {
  const response = await app.request(`/collaboration?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test("a group is created with its members in one request, titled by their names when no title is given", async () => {
  await using tmp = await tmpdir()
  await configureConnections({ node: { command: process.execPath } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const app = Server.App()
      const created = await post(app, tmp.path, {
        leader: { name: "小主" },
        seats: [{ name: "小红", role: "产品经理", product: "node" }],
      })
      expect(created.status).toBe(200)
      const session = await Session.get(created.body.sessionID as string)
      expect(session.title).toBe("小主、小红")
      expect(session.metadata).toEqual({ group: true })
    },
  })
})

test("a bad member or a product that is not installed creates nothing", async () => {
  await using tmp = await tmpdir()
  await configureConnections({ gone: { command: "merak-missing-cli" } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const app = Server.App()
      const before = (await Array.fromAsync(Session.list())).length
      expect(
        (await post(app, tmp.path, { leader: { name: "小主" }, seats: [{ name: "小 红", product: "merak" }] })).status,
      ).toBe(400)
      expect(
        (await post(app, tmp.path, { leader: { name: "小主" }, seats: [{ name: "小红", product: "gone" }] })).status,
      ).toBe(400)
      expect((await Array.fromAsync(Session.list())).length).toBe(before)
    },
  })
})

test("a refused change is explained in the user's language", async () => {
  for (const [locale, duplicate, missing] of [
    [undefined, "已有成员叫这个名字", "这些产品未接通：gone（merak-missing-cli 未安装）"],
    [
      "en-US",
      "Another member already has this name",
      "These products are not connected: gone (merak-missing-cli is not installed)",
    ],
  ] as const) {
    await using tmp = await tmpdir({
      config: {
        ...(locale ? { locale } : {}),
      },
    })
    await configureConnections({ gone: { command: "merak-missing-cli" } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const taken = await post(app, tmp.path, {
          leader: { name: "小主" },
          seats: [{ name: "小主", product: "merak" }],
        })
        expect(taken.body.message).toBe(duplicate)
        const absent = await post(app, tmp.path, {
          leader: { name: "小主" },
          seats: [{ name: "小红", product: "gone" }],
        })
        expect(absent.body.message).toBe(missing)
      },
    })
  }
})

test("groups of every project can be listed to copy, newest first, without anyone's private session", async () => {
  await configureConnections({ node: { command: process.execPath } })
  await using a = await tmpdir()
  await using b = await tmpdir()
  const made = await Instance.provide({
    directory: a.path,
    fn: async () => {
      const app = Server.App()
      const first = await post(app, a.path, {
        title: "登录小组",
        leader: { name: "小主", duty: "带队" },
        seats: [{ name: "小红", role: "产品经理", duty: "写需求", product: "node" }],
      })
      const group = first.body.group as { seats: { id: string; leader: boolean }[] }
      await remember(first.body.sessionID as string, group.seats.find((seat) => !seat.leader)!.id, "private-1")
      await Session.create({ title: "普通对话" })
      const second = await post(app, a.path, { title: "支付小组", leader: { name: "老大" } })
      return [first.body.sessionID, second.body.sessionID]
    },
  })
  await Instance.provide({
    directory: b.path,
    fn: async () => {
      const response = await Server.App().request(`/collaboration?directory=${encodeURIComponent(b.path)}`)
      expect(response.status).toBe(200)
      const groups = ((await response.json()) as { sessionID: string }[]).filter((item) =>
        made.includes(item.sessionID),
      )
      expect(groups).toEqual([
        {
          sessionID: made[1],
          title: "支付小组",
          directory: a.path,
          seats: [
            { name: "老大", role: "", duty: "", product: "merak", leader: true, availability: { state: "online" } },
          ],
        },
        {
          sessionID: made[0],
          title: "登录小组",
          directory: a.path,
          seats: [
            { name: "小主", role: "", duty: "带队", product: "merak", leader: true, availability: { state: "online" } },
            {
              name: "小红",
              role: "产品经理",
              duty: "写需求",
              product: "node",
              leader: false,
              availability: { state: "online" },
            },
          ],
        },
      ])
    },
  })
})
