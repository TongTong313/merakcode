import { expect, test } from "vitest"
import { tmpdir } from "../fixture/fixture"
import { Auth } from "@merakcode/engine/auth/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Provider } from "@merakcode/engine/provider/provider"
import { ErrorCode } from "@merakcode/util/error-code"

test("the default model comes from the highest-ranked connected provider", async () => {
  await using tmp = await tmpdir()
  await Auth.set("openai", { type: "api", key: "openai-key" })
  await Auth.set("alibaba-cn", { type: "api", key: "dashscope-key" })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await Provider.defaultModel()).providerID).toBe("alibaba-cn")
        expect(Provider.rank(Object.values(await Provider.list())).map((p) => p.id)[0]).toBe("alibaba-cn")
      },
    })
  } finally {
    await Auth.remove("openai")
    await Auth.remove("alibaba-cn")
  }
})

test("with no provider connected there is no default model, and the error says so with its own code", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const error = await Provider.defaultModel().catch((error: unknown) => error)
      expect(Provider.NoModelError.isInstance(error)).toBe(true)
      expect(ErrorCode.of((error as Error).name)).toBe(ErrorCode.CATALOG.NO_MODEL.code)
    },
  })
})
