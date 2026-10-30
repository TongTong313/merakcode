import { describe, expect, test } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const toolDir = join(import.meta.dirname, "../../../../packages/engine/src/agent/tools")

const lspDir = join(import.meta.dirname, "../../../../packages/engine/src/agent/lsp")

/** Edit tools must fetch diagnostics through diagnosticsAfterEdit, not await touchFile(true) plus diagnostics */
describe("edit tool LSP diagnostics wiring (diagnosticsAfterEdit)", () => {
  for (const file of ["write.ts", "edit.ts", "multi_edit.ts"]) {
    test(`${file} uses LSP.diagnosticsAfterEdit`, () => {
      const src = readFileSync(join(toolDir, file), "utf8")
      expect(src).toContain("LSP.diagnosticsAfterEdit")
      expect(src).not.toMatch(/await LSP\.touchFile\([^)]*,\s*true\)/)
    })
  }

  test("the interactive lsp tool still uses touchFile(true)", () => {
    const src = readFileSync(join(toolDir, "lsp.ts"), "utf8")
    expect(src).toMatch(/await LSP\.touchFile\(file,\s*true\)/)
  })

  test("lsp/index collectForEdit uses pickClientsForEditDiagnostics (ready clients first, timeout fallback)", () => {
    const src = readFileSync(join(lspDir, "index.ts"), "utf8")
    expect(src).toContain("pickClientsForEditDiagnostics")
    expect(src).toContain("diagnosticsAfterEdit")
  })
})
