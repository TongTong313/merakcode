import { expect, test } from "vitest"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { alive, sequence, until } from "../fixture/sdk-sequence"
import { assertPersisted } from "../fixture/sequence-persistence"
import { pty } from "../fixture/sequence-pty"
import { Filesystem } from "@merakcode/util/filesystem"

test("persistence oracle rejects dropped text and tool output from an actual completed turn", async () => {
  const kit = await sequence("read")
  let success = false
  try {
    const session = await kit.api("/session", "POST", { title: "Oracle persistence" })
    const input = "I1_READ read the actual marker"
    await kit.api(`/session/${session.id}/message`, "POST", {
      agent: "build",
      model: { providerID: "alibaba", modelID: "qwen-plus" },
      parts: [{ type: "text", text: input }],
    })
    const current = await kit.assertResult(session.id, await kit.submitted(session.id, input))
    const records = (
      await Filesystem.readText(join(kit.root, "data/merakcode/storage/transcript", `${session.id}.jsonl`))
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
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

test("PTY normal-exit oracle rejects an actual nonzero process exit", async () => {
  const kit = await sequence("read")
  let success = false
  try {
    const session = await kit.api("/session", "POST", { title: "Oracle exit" })
    const terminal = await pty(kit, session.id, "Oracle exit")
    process.kill(terminal.pid, "SIGKILL")
    await until(() => terminal.exit() !== undefined && !alive(terminal.pid), "negative PTY actual exit")
    expect(() => terminal.exited()).toThrow("PTY normal exit failed")
    expect(terminal.exit()?.source).toBe("natural")
    success = true
  } finally {
    await kit.finish(success)
  }
}, 60_000)

test("PTY receipt failure preserves original error and still closes backend and provider", async () => {
  const kit = await sequence("read")
  const original = new Error("Owned synthetic assertion failure")
  try {
    const session = await kit.api("/session", "POST", { title: "Oracle cleanup" })
    const terminal = await pty(kit, session.id, "Oracle cleanup")
    await mkdir(join(kit.artifacts, `terminal-summary-${terminal.pid}.json`), { recursive: true })
    const result = await kit.finish(false, original).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toContain(original)
    const summary = await Filesystem.readJson(join(kit.artifacts, "summary.json"))
    expect(summary.cleanupSucceeded).toBe(false)
    expect(summary.overallSuccess).toBe(false)
    expect(summary.cleanup.some((value: string) => value.startsWith("PTY cleanup failed"))).toBe(true)
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
      model: { providerID: "alibaba", modelID: "qwen-plus" },
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
