import { expect, test } from "vitest"
import { providerLogo } from "./provider-logo"

const OFFICIAL = ["alibaba-cn", "deepseek", "zhipuai", "moonshotai-cn", "openai", "anthropic", "google", "openrouter"]

test("built-in providers have a bundled logo and a custom provider does not", () => {
  const logos = OFFICIAL.map((id) => {
    const logo = providerLogo(id)
    expect(logo, id).toMatch(/svg/i)
    return logo
  })
  expect(new Set(logos).size).toBe(OFFICIAL.length)
  expect(providerLogo("my-gateway")).toBeUndefined()
})
