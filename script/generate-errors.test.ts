import { describe, expect, test } from "vitest"
import { ErrorCode } from "@merakcode/util/error-code"
import { render } from "./generate-errors"
import { buildCatalog, checkOutputs } from "./generate-errors"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

describe("docs/errors.md", () => {
  const text = render()

  test("lists every code with its Chinese and English title", () => {
    for (const spec of Object.values(ErrorCode.CATALOG as Record<string, ErrorCode.Spec>)) {
      expect(text).toContain(`| ${spec.code} |`)
      expect(text).toContain(spec.title.zh)
      expect(text).toContain(spec.title.en)
    }
  })

  test("lists codes in numeric order", () => {
    expect(text.indexOf("MRK-8001")).toBeLessThan(text.indexOf("MRK-8002"))
    expect(text.indexOf("MRK-8002")).toBeLessThan(text.indexOf("MRK-8004"))
  })

  test("says it is generated, so nobody edits it by hand", () => {
    expect(text).toContain("pnpm generate:errors")
  })
})

test("generates both languages from JSON and rejects stale outputs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "merak-errors-"))
  try {
    const catalog = {
      domains: { task: 6, host: 7 },
      codes: {
        TASK_BLOCKED: {
          code: "MRK-6001",
          domain: "task",
          status: 409,
          retryable: false,
          title: { zh: "任务阻塞", en: "Task blocked" },
          hint: { zh: "检查任务。", en: "Check the task." },
        },
        HOST_OFFLINE: {
          code: "MRK-7001",
          domain: "host",
          status: 503,
          retryable: true,
          title: { zh: "宿主离线", en: "Host offline" },
          hint: { zh: "连接宿主。", en: "Connect the host." },
        },
      },
    }
    const outputs = await buildCatalog(catalog)
    expect(outputs.typescript).toContain('code: "MRK-6001"')
    expect(outputs.go).toContain('TaskBlocked = "MRK-6001"')
    expect(outputs.go).toContain('HostOffline = "MRK-7001"')
    const files = [
      { file: path.join(dir, "catalog.ts"), text: outputs.typescript },
      { file: path.join(dir, "catalog.go"), text: outputs.go },
    ]
    for (const file of files) await writeFile(file.file, file.text)
    expect(await checkOutputs(files)).toEqual([])
    catalog.codes.HOST_OFFLINE.title.en = "Storage host offline"
    const changed = await buildCatalog(catalog)
    expect(
      await checkOutputs([
        { ...files[0], text: changed.typescript },
        { ...files[1], text: changed.go },
      ]),
    ).toHaveLength(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
