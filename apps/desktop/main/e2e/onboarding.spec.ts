import { test, expect } from "./fixture"

// First launch without an available model: onboarding asks to connect one and can be skipped

test.use({ config: { model: undefined, small_model: undefined, enabled_providers: undefined, provider: undefined } })

test("shows onboarding without a model; skipping shows the input and a no-model notice", async ({ kit }) => {
  // The fixture already skipped onboarding while waiting for the input; reload to show it and skip again
  await kit.page.reload()
  const onboarding = kit.page.getByRole("dialog", { name: "连接一个模型" })
  await expect(onboarding).toBeVisible({ timeout: 60_000 })
  await expect(onboarding.getByRole("button", { name: "阿里云百炼" })).toBeVisible()
  await onboarding.getByRole("button", { name: "跳过" }).click()
  await expect(onboarding).toHaveCount(0)
  await expect(kit.page.getByRole("textbox", { name: "消息" })).toBeVisible()
  await expect(kit.page.getByText("还没有连接模型")).toBeVisible()
})
