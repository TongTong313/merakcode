import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { containProcess } from "./tree"
import { ChildEnv } from "@merakcode/util/child-env"

// The supervisor waits for stdin so containment is installed before any user code can start.
const supervisor = `
import { spawn } from "node:child_process"
import { constants } from "node:os"
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString())
const child = spawn(input.file, input.args, { shell: input.shell, env: input.env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true })
child.once("error", error => { process.stderr.write(error.message); process.exitCode = 127 })
child.once("exit", (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] ?? 0)))
`

/** Starts commands only after their complete process tree can be stopped and verified. */
export async function spawnOwnedCommand(input: {
  file: string
  args?: string[]
  shell?: string
  cwd: string
  env: Record<string, string>
  pick: Parameters<typeof containProcess>[2]
  signal?: AbortSignal
  beforeStart?: () => Promise<void>
}) {
  const marker = { name: "MERAKCODE_COMMAND_RUN", value: randomUUID() }
  const env = ChildEnv.build({})
  for (const key of Object.keys(env)) if (/^(NODE_|LD_|DYLD_)/i.test(key)) delete env[key]
  const proc = spawn(process.execPath, ["--input-type=module", "--eval", supervisor], {
    cwd: input.cwd,
    env: { ...env, [marker.name]: marker.value },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  })
  proc.stdin.on("error", () => {})
  proc.on("error", () => {})
  let terminate: (() => Promise<void>) | undefined
  try {
    terminate = await containProcess(proc, marker, input.pick)
    await input.beforeStart?.()
    input.signal?.throwIfAborted()
    let stopped: Promise<void> | undefined
    const stopTree = terminate
    const stop = () => (stopped ??= stopTree())
    proc.stdin.end(
      JSON.stringify({
        file: input.file,
        args: input.args ?? [],
        shell: input.shell,
        env: { ...input.env, [marker.name]: marker.value },
      }),
    )
    return { proc, stop }
  } catch (error) {
    if (terminate) await terminate()
    else proc.kill()
    throw error
  }
}
