import { describe, expect, test } from "vitest"
import { writeFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { EngineExitedError, EngineStartError, MerakCodeError, fromResponse, isMerakCodeError } from "../src/index"
import { resolveEngine, startEngine } from "../src/process/index"

describe("fromResponse", () => {
  test("keeps the engine's code, message and request id, and the HTTP status", () => {
    const error = fromResponse(
      { name: "NotFoundError", code: "MRK-1011", message: "session ses_1 not found", requestID: "req-1" },
      new Response(null, { status: 404 }),
    )
    expect(error).toBeInstanceOf(MerakCodeError)
    expect(error).toMatchObject({
      code: "MRK-1011",
      status: 404,
      requestID: "req-1",
      message: "session ses_1 not found",
    })
    expect(error.retryable).toBe(false)
  })

  test("an error that only has a name gets the code of that name", () => {
    const error = fromResponse({ name: "ProviderModelNotFoundError", data: { providerID: "x", modelID: "y" } })
    expect(error.code).toBe("MRK-2002")
    expect(error.message).toBe("Model not found")
  })

  test("falls back to a code that matches the status when the body has none", () => {
    expect(fromResponse("Unauthorized", new Response(null, { status: 401 })).code).toBe("MRK-1005")
    expect(fromResponse(undefined, new Response(null, { status: 500 })).code).toBe("MRK-9000")
  })
})

describe("engine process errors", () => {
  test("an engine that exits before listening fails with MRK-1003 and its last output", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sdk-errors-"))
    try {
      const script = path.join(dir, "fail.mjs")
      await writeFile(script, 'console.error("bad config"); process.exit(3)\n')
      const error = await startEngine({ executablePath: [process.execPath, script], cwd: dir }).catch((e) => e)
      expect(error).toBeInstanceOf(EngineStartError)
      expect(isMerakCodeError(error)).toBe(true)
      expect(error.code).toBe("MRK-1003")
      expect(error.message).toContain("bad config")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a missing platform package fails with MRK-1001", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sdk-errors-"))
    try {
      let error: unknown
      try {
        resolveEngine(pathToFileURL(path.join(dir, "index.js")).href)
      } catch (e) {
        error = e
      }
      expect(isMerakCodeError(error)).toBe(true)
      expect((error as MerakCodeError).code).toBe("MRK-1001")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("an engine that dies while in use reports MRK-1004 with its exit code", () => {
    const error = new EngineExitedError(9)
    expect(error.code).toBe("MRK-1004")
    expect(error.message).toContain("9")
  })
})
