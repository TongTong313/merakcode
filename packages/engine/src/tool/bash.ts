import z from "zod"
import { unlink } from "fs/promises"
import { spawn } from "child_process"
import { finished } from "stream/promises"
import { Tool } from "./tool"
import DESCRIPTION from "./bash.txt"
import { Log } from "@merakcode/log/logger"
import { Instance } from "../project/instance"
import { Workspace } from "../project/workspace"

import { Flag } from "../flag/flag.ts"
import { Shell } from "../shell/shell"

import path from "path"
import { CommandAnalysis } from "../permission/command"
import { PermissionNext } from "../permission/next"
import { Sandbox } from "../sandbox"
import { PermissionPolicy } from "../permission/policy"
import { FileTime } from "../file/time"
import { Truncate } from "./truncation"
import { Plugin } from "../plugin"
import { compactBashOutputFile, getConfiguredOutputCompactionConfig } from "./bash-output-compaction"
import { compactLossless, getConfiguredLosslessConfig } from "./lossless"
import { createToolOutputSink, metadataTail } from "./output-sink"
import { Filesystem } from "@merakcode/util/filesystem"
import { Text } from "../util/text"
import { ChildEnv } from "@merakcode/util/child-env"
import { Config } from "../config/config"
import { Redact } from "../util/redact"

const MAX_METADATA_LENGTH = 30_000
const METADATA_THROTTLE_MS = 500
const DEFAULT_TIMEOUT = Flag.MERAKCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
/**
 * Upper bound on waiting for stdout/stderr to drain after a normal exit.
 * Draining normally takes about 1 ms; this is a safety net because a grandchild process may inherit stdout and keep
 * it open, and without a limit one command could hang the whole tool call.
 */
const STREAM_FLUSH_TIMEOUT_MS = 500

export const log = Log.create({ service: "bash-tool" })

/**
 * Approval before running: tree-sitter splits the command into segments (see CommandAnalysis), each segment is
 * judged by its level (read-only, normal, delete, high risk), and the ones that need asking are combined into one
 * approval that marks risks such as paths outside the workspace, network access, privilege escalation and deletion.
 *
 * readOnly: only when every segment is read-only with no output redirection may bash run in parallel with edit /
 * write. Otherwise the whole command takes the global write barrier (see FileTime.acquireBarrier): which files bash
 * writes cannot be known statically, and without the barrier it and a parallel edit could lose each other's updates.
 */
export async function prepareBashCommand(
  params: { command: string; workdir?: string; description: string } & Escalation,
  ctx: Tool.Context,
) {
  // An absolute workdir may be under any root; a relative one resolves against the primary root, as in
  // Workspace.resolveToolPath
  const cwd = params.workdir
    ? Workspace.resolveToolPath(Instance.workspace, params.workdir).filepath
    : Instance.directory

  const scope = PermissionPolicy.scope()
  const analysis = await CommandAnalysis.analyze(params.command, { cwd, ...scope })
  const prefix = analysis.segments[0]?.prefix ?? params.command
  // Credential paths are asked about even for read-only commands; outside paths too when the command only reads
  const reads = analysis.paths.flatMap((file) => {
    const check = PermissionPolicy.file({ op: "read", path: file, ...scope })
    if (check.permission === "sensitive_read") return [check]
    return analysis.readOnly && check.permission === "external_read" ? [check] : []
  })
  // The sandbox should be used but is not ready: commands that change things ask first, even in auto mode
  // ("required" mode refuses every command instead)
  const unsandboxed = !params.unsandboxed && (await Sandbox.missing()) && !analysis.readOnly
  await ctx.ask({
    permission: "bash",
    checks: [
      ...analysis.segments.map((segment) =>
        PermissionPolicy.command({ command: segment.text, level: segment.level, prefix: segment.prefix }),
      ),
      ...reads,
      ...(unsandboxed ? [PermissionPolicy.unsandboxed(params.command, prefix)] : []),
    ],
    metadata: {
      command: params.command,
      description: params.description,
      cwd,
      tags: unsandboxed ? [...analysis.tags, "no-sandbox"] : analysis.tags,
    },
  })
  const sandbox = await escalate(params, cwd, prefix, ctx)

  // Same shell.env input as @opencode-ai/plugin@1.16.2, including session and call ids, so plugins can inject a
  // different environment per session
  const shellEnv = await Plugin.trigger("shell.env", { cwd, sessionID: ctx.sessionID, callID: ctx.callID }, { env: {} })
  return { cwd, shellEnv: shellEnv.env as Record<string, string>, readOnly: analysis.readOnly, sandbox }
}

/** Extra permissions the agent requests when a command needs to leave the sandbox; approved under the sandbox key */
export const SandboxEscalation = {
  writable_paths: z
    .array(z.string())
    .describe(
      "Only after the sandbox blocked a write: extra directories outside the workspace the command must write to. The user approves them.",
    )
    .optional(),
  unsandboxed: z
    .boolean()
    .describe(
      "Only after the sandbox blocked the command and writable_paths cannot fix it (e.g. a non-HTTP network connection): run outside the sandbox. The user approves it.",
    )
    .optional(),
  justification: z
    .string()
    .describe("Required with writable_paths or unsandboxed: one sentence telling the user why the command needs it")
    .optional(),
}

type Escalation = { writable_paths?: string[]; unsandboxed?: boolean; justification?: string }

/** Requests extra permissions as one approval: one entry per directory, plus one for running outside the sandbox */
async function escalate(params: Escalation & { command: string }, cwd: string, prefix: string, ctx: Tool.Context) {
  const writable = (params.writable_paths ?? []).map((dir) => path.resolve(cwd, dir))
  if (!writable.length && !params.unsandboxed) return { writable }
  const directory = (dir: string) => PermissionNext.normalizePath(dir).replace(/\/$/, "") + "/*"
  await ctx.ask({
    permission: "sandbox",
    checks: [
      ...writable.map((dir) => ({
        permission: "sandbox",
        pattern: directory(dir),
        grants: [{ scope: "directory" as const, pattern: directory(dir) }],
      })),
      ...(params.unsandboxed
        ? [
            {
              permission: "sandbox",
              pattern: params.command,
              grants: [{ scope: "prefix" as const, pattern: `${prefix} *` }],
            },
          ]
        : []),
    ],
    metadata: {
      command: params.command,
      writable,
      unsandboxed: !!params.unsandboxed,
      justification: params.justification,
    },
  })
  return { writable, unsandboxed: params.unsandboxed }
}

/**
 * Starts the command: wrapped in the sandbox when it is on (the wrapped argv runs with shell: false), otherwise
 * through the shell. Call finish when the command ends: it removes the network approval registration and appends the
 * operations the sandbox blocked, which the agent uses to request extra permissions.
 */
export async function spawnCommand(input: {
  command: string
  shell: string
  cwd: string
  env: Record<string, string>
  ctx: Tool.Context
  sandbox: { writable: string[]; unsandboxed?: boolean }
}) {
  const options = {
    cwd: input.cwd,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    // On Linux and macOS, detached creates a process group so Shell.killTree can kill the whole group
    detached: process.platform !== "win32",
  }
  const env = ChildEnv.build({ extra: input.env })
  const wrapped = input.sandbox.unsandboxed
    ? undefined
    : await Sandbox.wrap({
        command: input.command,
        shell: input.shell,
        cwd: input.cwd,
        env,
        ctx: input.ctx,
        workspace: PermissionPolicy.scope().workspace,
        writable: input.sandbox.writable,
      })
  if (!wrapped)
    return {
      proc: spawn(input.command, { ...options, shell: input.shell, env }),
      finish: (output: string, _exitCode?: number | null) => output,
    }
  try {
    return {
      proc: spawn(wrapped.file, wrapped.args, { ...options, shell: false, windowsHide: true, env: wrapped.env }),
      finish: (output: string, exitCode: number | null = null) => {
        const report = wrapped.finish(output, exitCode)
        return report ? `${output}\n\n${report}` : output
      },
    }
  } catch (error) {
    wrapped.finish("", null)
    throw error
  }
}

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  log.info("bash tool using shell", { shell })

  return {
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
      ...SandboxEscalation,
    }),
    async execute(params, ctx) {
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT

      const { cwd, shellEnv, readOnly, sandbox } = await prepareBashCommand(params, ctx)
      const outputSink = await createToolOutputSink({ maxMetadataLength: MAX_METADATA_LENGTH })
      const outputCompactionConfig = await getConfiguredOutputCompactionConfig()
      const losslessConfig = await getConfiguredLosslessConfig()

      // Commands that may write files exclude edit / write: which files they change cannot be known statically, so
      // the barrier is held for the whole process lifetime, otherwise a parallel edit could lose updates. Read-only
      // commands (git status, ls, grep, ...) still run in parallel with edits, which is where most of the gain is.
      const releaseBarrier = readOnly ? undefined : await FileTime.acquireBarrier()

      let started: Awaited<ReturnType<typeof spawnCommand>>
      try {
        started = await spawnCommand({ command: params.command, shell, cwd, env: shellEnv, ctx, sandbox })
      } catch (error) {
        // Release the barrier when spawn throws too, otherwise every later edit / write is blocked forever
        releaseBarrier?.()
        throw error
      }

      const proc = started.proc
      let metadataTimer: ReturnType<typeof setTimeout> | undefined
      let lastMetadataAt = 0

      const emitMetadata = () => {
        lastMetadataAt = Date.now()
        ctx.metadata({
          metadata: {
            output: outputSink.tail(),
            description: params.description,
          },
        })
      }

      const scheduleMetadata = () => {
        const elapsed = Date.now() - lastMetadataAt
        if (elapsed >= METADATA_THROTTLE_MS) {
          if (metadataTimer) {
            clearTimeout(metadataTimer)
            metadataTimer = undefined
          }
          emitMetadata()
          return
        }
        if (!metadataTimer) {
          metadataTimer = setTimeout(() => {
            metadataTimer = undefined
            emitMetadata()
          }, METADATA_THROTTLE_MS - elapsed)
        }
      }

      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      const append = (chunk: Buffer) => {
        outputSink.append(chunk, {
          pause: () => {
            proc.stdout?.pause()
            proc.stderr?.pause()
          },
          resume: () => {
            proc.stdout?.resume()
            proc.stderr?.resume()
          },
        })
        scheduleMetadata()
      }

      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      let timedOut = false
      let aborted = false
      let exited = false

      const kill = () => Shell.killTree(proc, { exited: () => exited })

      if (ctx.abort.aborted) {
        aborted = true
        await kill()
      }

      const abortHandler = () => {
        aborted = true
        void kill()
      }

      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      const timeoutTimer = setTimeout(() => {
        timedOut = true
        void kill()
      }, timeout + 100)

      try {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timeoutTimer)
            ctx.abort.removeEventListener("abort", abortHandler)
          }

          proc.once("exit", () => {
            exited = true
            cleanup()
            resolve()
          })

          proc.once("error", (error) => {
            exited = true
            cleanup()
            reject(error)
          })
        })
      } catch (error) {
        started.finish("")
        outputSink.destroy()
        await unlink(outputSink.path).catch(() => {})
        throw error
      } finally {
        // The process has exited and can no longer touch files, so let blocked edit / write calls proceed
        releaseBarrier?.()
      }

      const resultMetadata: string[] = []

      if (timedOut) {
        resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout} ms`)
      }

      if (aborted) {
        resultMetadata.push(
          "The user manually stopped this command before completion. " +
            "Do not retry the same command unless the user explicitly asks or you have changed the approach.",
        )
      }

      const resultMetadataOutput =
        resultMetadata.length > 0 ? "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>" : ""

      // Also added to metadata.output for the user's tool card, so it uses the UI language
      const undoWarning =
        "\n\n" +
        (await Text.pick({
          zh: "注意：bash 操作无法通过 undo 撤销。",
          en: "Note: bash operations cannot be reverted with undo.",
        }))

      // The child_process 'exit' event only means the process ended; stdout/stderr may still hold data in flight.
      // Closing now would let late data events write to an ended stream and throw ERR_STREAM_WRITE_AFTER_END (only
      // seen under heavy parallel test load). So after a normal exit, wait for both streams to reach EOF first.
      //
      // Do not wait after a kill (timeout or user abort): the output is cut off anyway, and a grandchild that
      // inherited stdout may keep it open, so waiting would just run into the limit. The sink's write-after-end
      // guard keeps this path from crashing.
      if (!timedOut && !aborted) {
        await Promise.all(
          [proc.stdout, proc.stderr].map((stream) =>
            stream
              ? finished(stream, { signal: AbortSignal.timeout(STREAM_FLUSH_TIMEOUT_MS) }).catch(() => {})
              : undefined,
          ),
        )
      }

      if (metadataTimer) clearTimeout(metadataTimer)
      emitMetadata()
      await outputSink.close()
      const outputPath = outputSink.path
      const outputSize = await Filesystem.size(outputPath)
      const compacted = await compactBashOutputFile(
        {
          command: params.command,
          cwd,
          sessionID: ctx.sessionID,
          exitCode: proc.exitCode,
          outputPath,
          outputSize,
        },
        outputCompactionConfig,
      )

      // When lossy compaction (off by default) does not apply, try lossless folding (on by default) before
      // truncating, so the bytes saved mean less content is cut. The output is only read into memory when it is
      // large enough to matter.
      const lossless = await (async () => {
        if (compacted) return undefined
        if (!losslessConfig.enabled) return undefined
        if (outputSize < losslessConfig.minBytes) return undefined
        const text = await Filesystem.readText(outputPath)
        return compactLossless(text, losslessConfig) ?? undefined
      })()

      const truncated = compacted
        ? undefined
        : lossless
          ? Truncate.outputText(lossless.output, outputPath)
          : await Truncate.outputFile(outputPath)
      if (!compacted && truncated && !truncated.truncated) {
        await unlink(outputPath).catch(() => {})
      }
      // Operations the sandbox blocked are appended after truncation; the agent uses them to request writable_paths
      // or unsandboxed
      const baseOutput = started.finish(compacted ? compacted.output : truncated!.content, proc.exitCode)
      const redact = (await Config.get()).sandbox?.redactSecrets !== false
      const resultOutput = (redact ? Redact.secrets(baseOutput) : baseOutput) + resultMetadataOutput + undoWarning

      return {
        title: params.description,
        metadata: {
          output: metadataTail(outputSink.tail() + resultMetadataOutput + undoWarning, MAX_METADATA_LENGTH),
          exit: proc.exitCode,
          description: params.description,
          truncated: compacted ? false : truncated!.truncated,
          ...(compacted
            ? {
                compacted: true,
                compactionFilter: compacted.filterName,
                originalBytes: compacted.originalBytes,
                compactedBytes: compacted.compactedBytes,
                outputPath,
                rawOutputPath: compacted.rawOutputPath,
              }
            : truncated!.truncated && { outputPath: truncated!.outputPath }),
          ...(lossless && {
            lossless: true,
            losslessTransforms: lossless.applied,
            losslessOriginalBytes: lossless.originalBytes,
            losslessCompactedBytes: lossless.compactedBytes,
          }),
        },
        output: resultOutput,
      }
    },
  }
})
