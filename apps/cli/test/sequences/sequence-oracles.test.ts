import { expect, test } from "vitest"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { alive, sequence } from "../fixture/sdk-sequence"
import { assertPersisted, stored } from "../fixture/sequence-persistence"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

test("persistence oracle rejects dropped text and tool output from an actual completed turn", async () => {
  const kit = await sequence("read")
  let success = false
  try {
    const session = await kit.api("/session", "POST", { title: "Oracle persistence" })
    const input = "I1_READ read the actual marker"
    await kit.api(`/session/${session.id}/message`, "POST", {
      agent: "build",
      model: { providerID: "alibaba-cn", modelID: "qwen-plus" },
      parts: [{ type: "text", text: input }],
    })
    const current = await kit.assertResult(session.id, await kit.submitted(session.id, input))
    const records = stored(kit.root, session.id)
    expect(() => assertPersisted(current, records)).not.toThrow()
    for (const type of ["text", "tool"]) {
      const part = current.flatMap((item) => item.parts).find((part) => part.type === type)!
      expect(part).toBeDefined()
      const changed = structuredClone(part)
      if (type === "text") changed.text = ""
      else changed.state!.output = ""
      expect(() => assertPersisted(current, [...records, { type: "part", part: changed }])).toThrow(
        "persisted part content mismatch",
      )
      expect(() =>
        assertPersisted(current, [...records, { type: "remove", messageID: part.messageID, partID: part.id }]),
      ).toThrow("persisted part content mismatch")
    }
    success = true
  } finally {
    await kit.finish(success)
  }
}, 60_000)

test("a failed resource cleanup preserves the original error and still closes backend and provider", async () => {
  const kit = await sequence("read")
  const original = new Error("Owned synthetic assertion failure")
  try {
    const child = Process.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore" })
    kit.registerCleanup("Synthetic resource", child.pid!, async () => {
      child.kill()
      await child.exited
      throw new Error("Synthetic resource cleanup failure")
    })
    const result = await kit.finish(false, original).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toContain(original)
    const summary = await Filesystem.readJson(join(kit.artifacts, "summary.json"))
    expect(summary.cleanupSucceeded).toBe(false)
    expect(summary.overallSuccess).toBe(false)
    expect(summary.cleanup.some((value: string) => value.startsWith("Synthetic resource cleanup failed"))).toBe(true)
    expect(summary.remainingPIDs).toEqual([])
    expect(alive(summary.backendPID)).toBe(false)
    await expect(fetch(`${kit.url}/session`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
  } finally {
    // finish is idempotent; preserve the expected negative receipt.
    await kit.finish(false).catch(() => undefined)
  }
}, 60_000)

test("post-success evidence failure stays red despite successful resource cleanup", async () => {
  const kit = await sequence("read")
  try {
    const session = await kit.api("/session", "POST", { title: "Oracle finalization" })
    const input = "I1_READ read actual marker before evidence finalization"
    await kit.api(`/session/${session.id}/message`, "POST", {
      agent: "build",
      model: { providerID: "alibaba-cn", modelID: "qwen-plus" },
      parts: [{ type: "text", text: input }],
    })
    await kit.assertResult(session.id, await kit.submitted(session.id, input))
    const artifact = join(kit.artifacts, "sequence.json")
    await mkdir(artifact)
    const failure = await Filesystem.write(artifact, "{}").then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeDefined()
    const result = await kit.finish(true, failure).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(result).toBe(failure)
    const summary = await Filesystem.readJson(join(kit.artifacts, "summary.json"))
    expect(summary.assertionsPassed).toBe(true)
    expect(summary.cleanupSucceeded).toBe(true)
    expect(summary.finalizationSucceeded).toBe(false)
    expect(summary.overallSuccess).toBe(false)
    expect(summary.remainingPIDs).toEqual([])
    expect(alive(summary.backendPID)).toBe(false)
    expect(await Filesystem.isFile(join(kit.root, "project/src/a.txt"))).toBe(true)
  } finally {
    await kit.finish(false).catch(() => undefined)
  }
}, 60_000)
