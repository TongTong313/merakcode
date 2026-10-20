import { expect, test } from "vitest"
import enUS from "../../src/cli/locales/en-US.json"
import zhCN from "../../src/cli/locales/zh-CN.json"
import { Filesystem } from "@merakcode/util/filesystem"

const source = await Filesystem.readText(new URL("../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url))

test("TUI session keeps the AI-generated content disclaimer below the prompt", () => {
  expect(source).toContain('locale.t("session.aiDisclaimer")')
  expect(zhCN["session.aiDisclaimer"]).toBe("内容由AI生成，仅供参考")
  expect(enUS["session.aiDisclaimer"]).toBe("AI-generated, for reference only")
})
