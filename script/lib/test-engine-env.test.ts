import { expect, it } from "vitest"
import { testEngineEnv } from "./test-engine-env"

it("keeps provider and login credentials out of the test engine", () => {
  const env = testEngineEnv("/isolated", {
    PATH: "fixture-path",
    HOME: "/personal",
    DASHSCOPE_API_KEY: "canary",
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: "canary",
    ANTHROPIC_CUSTOM_HEADERS: "canary",
    HTTPS_PROXY: "https://proxy.invalid",
    NO_PROXY: "*",
  })
  expect(Object.values(env)).not.toContain("canary")
  expect(env).toMatchObject({
    PATH: "fixture-path",
    HOME: "/isolated",
    HTTPS_PROXY: "http://127.0.0.1:0",
    NO_PROXY: "127.0.0.1,::1,localhost",
  })
})
