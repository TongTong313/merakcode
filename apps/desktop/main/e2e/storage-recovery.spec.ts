import { test, expect } from "./fixture"

test.use({ git: true })

for (const language of ["zh", "en"])
  test(`unreadable draft storage reports a localized error and remains retryable in ${language}`, async ({ kit }) => {
    kit.git("branch", "feature")
    await kit.openPanel("git")
    if (language === "en") {
      await kit.settings()
      await kit.page
        .getByRole("button", { name: /^(语言|Language)/ })
        .filter({ visible: true })
        .first()
        .click()
      await kit.page
        .getByRole("option", { name: /English/ })
        .first()
        .click()
      await expect(kit.page.locator("html")).toHaveAttribute("lang", /^en/)
      await kit.page.keyboard.press("Escape")
    }
    const writeBucket = (content: string) =>
      kit.app.evaluate(
        ({ app }, { directory, content }) => {
          const fs = process.getBuiltinModule("fs")
          const path = process.getBuiltinModule("path")
          const storage = path.join(app.getPath("userData"), "storage")
          fs.mkdirSync(storage, { recursive: true })
          fs.writeFileSync(path.join(storage, `draft-${Buffer.from(directory).toString("base64url")}.json`), content)
        },
        { directory: kit.project, content },
      )
    await writeBucket("[]")
    await kit
      .panel()
      .getByRole("button", { name: /^(当前分支|Current branch)/ })
      .click()
    const error = kit.page.getByRole("alert")
    await expect(error).toContainText("MRK-4019")
    await expect(error).toContainText(language === "zh" ? "无法读取编辑区状态" : "Could not read editor state")
    await expect(error).not.toContainText("Invalid storage bucket")
    const feature = kit.page.getByRole("option", { name: /^feature/ })
    await expect
      .poll(async () => !(await feature.count()) || (await feature.getAttribute("aria-disabled")) === "true")
      .toBe(true)
    await writeBucket("{}")
    await kit.page.getByRole("button", { name: /^(重试|Retry)$/ }).click()
    await expect(error).toHaveCount(0)
    await expect(kit.page.getByRole("option", { name: /^feature/ })).not.toHaveAttribute("aria-disabled", "true")
  })
