import { expect, test } from "vitest"
import path from "path"
import { Auth } from "@merakcode/engine/agent/model/credentials"
import { tmpdir } from "../fixture/fixture"

test("concurrent auth.json updates preserve every entry", async () => {
  await using tmp = await tmpdir()
  const auth = Auth.create(path.join(tmp.path, "auth.json"))

  await Promise.all([
    auth.set("provider-a", { type: "api", key: "a" }),
    auth.set("provider-b", { type: "api", key: "b" }),
  ])

  expect(await auth.all()).toMatchObject({
    "provider-a": { type: "api", key: "a" },
    "provider-b": { type: "api", key: "b" },
  })
})
