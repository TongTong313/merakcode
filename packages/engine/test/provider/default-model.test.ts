import { expect, test } from "vitest"
import { tmpdir } from "../fixture/fixture"
import { Auth } from "@merakcode/engine/auth/index"
import { Env } from "@merakcode/engine/env/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Provider } from "@merakcode/engine/provider/provider"

// One environment variable can connect several providers (DASHSCOPE_API_KEY connects both the China and
// international Alibaba Model Studio), yet a key only works on one of them, so the default model must be predictable.

test("with only env vars, the default model comes from the highest-ranked provider (alibaba-cn before alibaba)", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    init: async () => Env.set("DASHSCOPE_API_KEY", "test-key"),
    fn: async () => {
      const providers = await Provider.list()
      expect(Object.keys(providers)).toEqual(expect.arrayContaining(["alibaba", "alibaba-cn"]))
      expect((await Provider.defaultModel()).providerID).toBe("alibaba-cn")
      expect(Provider.rank(Object.values(providers)).map((p) => p.id)[0]).toBe("alibaba-cn")
    },
  })
})

test("providers with a user-saved key rank ahead of ones detected from env vars", async () => {
  await using tmp = await tmpdir()
  await Auth.set("alibaba", { type: "api", key: "saved-key" })
  try {
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("DASHSCOPE_API_KEY", "test-key"),
      fn: async () => {
        expect((await Provider.defaultModel()).providerID).toBe("alibaba")
      },
    })
  } finally {
    await Auth.remove("alibaba")
  }
})
