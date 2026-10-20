import { expect, test } from "vitest"
import { join } from "node:path"
import { unavailableModel } from "../fixture/unavailable-model-sequence"
import { until } from "../fixture/sdk-sequence"
import { Filesystem } from "@merakcode/util/filesystem"

test("S02.06 P/M selected model endpoint refuses connections then same model completes after listener recovery", async () => {
  const kit = await unavailableModel()
  let success = false
  try {
    const session = await kit.api("/session", "POST", { title: "S02.06 isolated connection failure" })
    const request = async (text: string) => {
      const result = await fetch(`${kit.url}/session/${session.id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-merakcode-directory": kit.project },
        signal: AbortSignal.timeout(100_000),
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "alibaba", modelID: "qwen-max" },
          parts: [{ type: "text", text }],
        }),
      })
      await result.arrayBuffer()
      return result.status
    }
    const before = await Filesystem.readText(join(kit.project, "src/a.txt"))
    expect(
      await fetch(`http://127.0.0.1:${kit.port}/v1/chat/completions`).then(
        () => false,
        () => true,
      ),
    ).toBe(true)
    let settled = false
    const failed = request("S02_FAIL 选定模型不可达时读取文件")
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        settled = true
      })
    await until(() => settled, "actual unreachable endpoint reaches bounded terminal failure", 90_000)
    await failed
    const first = await kit.submitted(session.id, "S02_FAIL 选定模型不可达时读取文件")
    const original = await kit.api(`/session/${session.id}/message`)
    const errors = original.filter(
      (entry: { info: { parentID?: string; error?: unknown; time: { completed?: number } } }) =>
        entry.info.parentID === first && entry.info.error && entry.info.time.completed,
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(
      original
        .flatMap((entry: { parts: { type: string }[] }) => entry.parts)
        .some((part: { type: string }) => part.type === "tool"),
    ).toBe(false)
    expect(kit.selectedModels).toHaveLength(0)
    expect(await Filesystem.readText(join(kit.project, "src/a.txt"))).toBe(before)
    await kit.recover()
    await request("S02_RECOVER 使用原模型重新读取实际文件")
    const second = await kit.submitted(session.id, "S02_RECOVER 使用原模型重新读取实际文件")
    await kit.assertResult(session.id, second, "S02_RECOVERED")
    expect(kit.selectedModels.length).toBeGreaterThan(0)
    expect(kit.selectedModels.every((model) => model === "qwen-max")).toBe(true)
    const after = await kit.api(`/session/${session.id}/message`)
    expect(
      after.filter((entry: { info: { id: string } }) =>
        original.some((old: { info: { id: string } }) => old.info.id === entry.info.id),
      ),
    ).toEqual(original)
    await Filesystem.write(
      join(kit.artifacts, "sequence.json"),
      JSON.stringify({
        id: "S02.06",
        layer: "P/M",
        ui: "unverified",
        sessionID: session.id,
        first,
        second,
        errorNames: errors.map((entry: { info: { error: { name: string } } }) => entry.info.error.name),
        models: kit.selectedModels,
        originalFailurePreserved: true,
      }),
    )
    success = true
  } finally {
    await kit.finish(success)
  }
}, 150_000)
