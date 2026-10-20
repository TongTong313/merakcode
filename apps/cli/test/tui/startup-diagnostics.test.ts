import { describe, expect, test } from "vitest"
import { TuiStartupDiagnostics } from "../../src/cli/cmd/tui/startup-diagnostics"

describe("TUI startup diagnostics", () => {
  test("counts visible characters without retaining frame content", () => {
    expect(TuiStartupDiagnostics.visibleCharacters(" \n\t\0Prompt 编码 ")).toBe(8)
    expect(TuiStartupDiagnostics.visibleCharacters("   \n\t\0")).toBe(0)
  })

  test("logs only URL pathname", () => {
    expect(TuiStartupDiagnostics.requestPath("https://example.test/provider?token=secret#private")).toBe("/provider")
    expect(TuiStartupDiagnostics.requestPath("not a URL")).toBe("<invalid-url>")
  })

  test("uses an explicit environment whitelist", () => {
    const diagnostics = TuiStartupDiagnostics.environment("/project")
    expect(diagnostics.directory).toBe("/project")
    expect(diagnostics).not.toHaveProperty("API_KEY")
    expect(diagnostics).not.toHaveProperty("TOKEN")
    expect(diagnostics).not.toHaveProperty("process.env")
  })
})
