import { afterEach, expect, test } from "vitest"
import { Filesystem } from "@merakcode/util/filesystem"
import { globalConfigFile } from "@merakcode/util/paths"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Filesystem.write(globalConfigFile(), JSON.stringify({ $schema: Config.SCHEMA }))
  Config.invalidateScope("global")
  await Instance.disposeAll()
})

test("lists seven immutable built-in role templates without product bindings", async () => {
  await using project = await tmpdir()
  const response = await Server.App().request(
    `/collaboration/role-template?directory=${encodeURIComponent(project.path)}`,
  )
  expect(response.status).toBe(200)
  const templates = await response.json()
  expect(templates.map((item: { id: string }) => item.id)).toEqual([
    "builtin-product-manager",
    "builtin-architect",
    "builtin-developer",
    "builtin-tester",
    "builtin-reviewer",
    "builtin-devops",
    "builtin-security",
  ])
  for (const template of templates) {
    expect(template.builtin).toBe(true)
    expect(template.editable).toBe(false)
    expect(template.product).toBeUndefined()
    expect(template.model).toBeUndefined()
    expect(template.duty.length).toBeGreaterThan(20)
  }
})

test("rejects changes to an immutable built-in role template", async () => {
  await using project = await tmpdir()
  const response = await Server.App().request(
    `/collaboration/role-template?directory=${encodeURIComponent(project.path)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "update",
        id: "builtin-developer",
        template: { name: "Changed", role: "Changed", duty: "Changed" },
      }),
    },
  )
  expect(response.status).toBe(403)
})

test("adds a custom role template shared by projects", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir()
  const app = Server.App()
  const response = await app.request(`/collaboration/role-template?directory=${encodeURIComponent(first.path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "add",
      id: "custom-review",
      template: { name: "MyReviewer", role: "My role", duty: "My exact custom duty" },
    }),
  })
  expect(response.status).toBe(200)
  const list = await (
    await app.request(`/collaboration/role-template?directory=${encodeURIComponent(second.path)}`)
  ).json()
  expect(list).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "custom-review",
        name: "MyReviewer",
        duty: "My exact custom duty",
        builtin: false,
        editable: true,
      }),
    ]),
  )
})

test("updates a custom role template without changing existing group duties", async () => {
  await Filesystem.write(
    globalConfigFile(),
    JSON.stringify({
      $schema: Config.SCHEMA,
      collaboration: { roleTemplates: { own: { name: "Own", role: "Original role", duty: "Original duty" } } },
    }),
  )
  Config.invalidateScope("global")
  await using project = await tmpdir()
  const app = Server.App()
  const query = `directory=${encodeURIComponent(project.path)}`
  const created = await (
    await app.request(`/collaboration?${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leader: { name: "Leader" },
        seats: [{ name: "Own", role: "Original role", duty: "Original duty", product: "merak" }],
      }),
    })
  ).json()
  const response = await app.request(`/collaboration/role-template?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "update",
      id: "own",
      template: { name: "Changed", role: "Changed role", duty: "Changed duty" },
    }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "own", duty: "Changed duty" })]),
  )
  const group = await (await app.request(`/collaboration/${created.sessionID}?${query}`)).json()
  expect(group.seats).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Own", duty: "Original duty" })]))
})

test("deletes a custom role template", async () => {
  await Filesystem.write(
    globalConfigFile(),
    JSON.stringify({
      $schema: Config.SCHEMA,
      collaboration: { roleTemplates: { own: { name: "Own", role: "Role", duty: "Duty" } } },
    }),
  )
  Config.invalidateScope("global")
  await using project = await tmpdir()
  const response = await Server.App().request(
    `/collaboration/role-template?directory=${encodeURIComponent(project.path)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "remove", id: "own" }),
    },
  )
  expect(response.status).toBe(200)
  expect((await response.json()).some((item: { id: string }) => item.id === "own")).toBe(false)
})
