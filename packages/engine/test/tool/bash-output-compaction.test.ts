import { describe, expect, test } from "vitest"
import path from "path"
import {
  compactBashOutput,
  compactBashOutputFile,
  clearSessionDeltaCache,
} from "@merakcode/engine/agent/tools/bash-output-compaction/index"
import type { OutputCompactionConfig } from "@merakcode/engine/agent/tools/bash-output-compaction/index"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

const config: OutputCompactionConfig = {
  enabled: true,
  mode: "safe",
  sessionDelta: false,
  minBytes: 1,
  maxInputBytes: 1024 * 1024,
  maxCompactedBytes: 40 * 1024,
}

describe("OutputCompaction", () => {
  test("compacts verbose git status output", () => {
    const files = Array.from({ length: 40 }, (_, i) => `\tmodified:   src/file-${i}.ts`)
    const hints = Array.from({ length: 40 }, () => '\t(use "git add <file>..." to update what will be committed)')
    const stdout = [
      "On branch main",
      "Your branch is up to date with 'origin/main'.",
      "",
      "Changes not staged for commit:",
      ...hints,
      ...files,
      "",
      "no changes added to commit",
    ].join("\n")

    const result = compactBashOutput(
      {
        command: "git status",
        cwd: "/repo",
        exitCode: 0,
        stdout,
      },
      config,
    )

    expect(result).not.toBeNull()
    expect(result!.filterName).toBe("git-status")
    expect(result!.output).toContain("[output compacted: git-status")
    expect(result!.output).toContain("modified:   src/file-0.ts")
    expect(result!.output).toContain("git status hint/prose lines omitted")
    expect(result!.output).not.toContain('use "git add <file>..."')
  })

  test("skips structured json output in safe mode", () => {
    const result = compactBashOutput(
      {
        command: "tool --json",
        cwd: "/repo",
        exitCode: 0,
        stdout: JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i })) }),
      },
      config,
    )

    expect(result).toBeNull()
  })

  test("does not treat bracket-prefixed logs as json arrays", () => {
    const stdout = Array.from({ length: 80 }, (_, i) => `[ERROR] failed request id ${i}`).join("\n")
    const result = compactBashOutput(
      {
        command: "tail app.log",
        cwd: "/repo",
        exitCode: 0,
        stdout,
      },
      config,
    )

    expect(result).not.toBeNull()
    expect(result!.filterName).toBe("logs")
  })

  test("returns session delta for unchanged repeated command output", () => {
    clearSessionDeltaCache()
    const sessionConfig = { ...config, sessionDelta: true }
    const context = {
      command: "printf same-output",
      cwd: "/repo",
      sessionID: "session-a",
      exitCode: 0,
      stdout: Array.from({ length: 80 }, (_, i) => `same line ${i % 5}`).join("\n"),
    }

    expect(compactBashOutput(context, sessionConfig)).toBeNull()
    const repeated = compactBashOutput(context, sessionConfig)

    expect(repeated).not.toBeNull()
    expect(repeated!.filterName).toBe("session-delta")
    expect(repeated!.output).toContain("[unchanged] same output as previous")
    clearSessionDeltaCache()
  })

  test("compacts output from persisted file and preserves raw path", async () => {
    await using tmp = await tmpdir()
    const outputPath = path.join(tmp.path, "tool-output.txt")
    const stdout = Array.from({ length: 80 }, (_, i) => `ERROR 2026-01-01T00:00:00 failed request id ${i}`).join("\n")
    await Filesystem.write(outputPath, stdout)

    const result = await compactBashOutputFile(
      {
        command: "tail app.log",
        cwd: tmp.path,
        sessionID: "session-a",
        exitCode: 0,
        outputPath,
        outputSize: await Filesystem.size(outputPath),
      },
      config,
    )

    expect(result).not.toBeNull()
    expect(result!.filterName).toBe("logs")
    expect(result!.rawOutputPath).toBe(outputPath)
    expect(result!.output).toContain("[full output saved:")
    expect(await Filesystem.readText(outputPath)).toBe(stdout)
  })
})
