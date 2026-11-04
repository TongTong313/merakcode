import fs from "node:fs/promises"
import path from "node:path"
import { adapter, spawn, stop } from "@merakcode/sdk/adapter"
import type { ChildProcess } from "node:child_process"

const active = new Map<string, { child: ChildProcess; closed: Promise<number | null> }>()
let unconfirmed = false
let finishBeforeCancelReceipt: PromiseWithResolvers<void> | undefined

adapter({
  cancelOperation: async (id) => {
    if (unconfirmed) return { stopped: false }
    const operation = active.get(id)
    if (!operation) return { stopped: true }
    await stop(operation.child)
    await operation.closed
    if (finishBeforeCancelReceipt) {
      await finishBeforeCancelReceipt.promise
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return { stopped: true }
  },
  inspect: () => ({
    name: "Operation fixture",
    capabilities: {
      modelSelection: false,
      modelDiscovery: false,
      textStreaming: false,
      resume: false,
      permission: "merak",
      questions: false,
      plan: { fullInput: true, contextTokens: 200000, reservedTokens: 1000, fixedInputTokens: 100 },
      control: {
        reportedOperations: ["read", "write", "command", "network", "tool"],
        cancellation: "operation",
        liveMode: true,
        limitations: [],
      },
    },
  }),
  async run(task, host) {
    unconfirmed = task.prompt === "hold-unconfirmed"
    finishBeforeCancelReceipt = task.prompt === "hold-completed" ? Promise.withResolvers<void>() : undefined
    await fs.writeFile(path.join(task.cwd, "task-received"), "RECEIVED")
    const decision = await host.operationStart({
      id: "write-once",
      request: { kind: "write", paths: ["effect.txt"] },
      isolation: "none",
    })
    if (!decision.allow) return { text: "DENIED" }
    decision.signal.throwIfAborted()
    const child = spawn(
      process.execPath,
      [
        "-e",
        process.argv[2] === "stopped" || task.prompt.startsWith("hold")
          ? "require('node:fs').writeFileSync('effect.txt',String(process.pid));setInterval(()=>{},1000)"
          : process.argv[2] === "failed"
            ? "process.exit(7)"
            : "require('node:fs').writeFileSync('effect.txt','CHANGED')",
      ],
      { cwd: task.cwd, stdio: "ignore", windowsHide: true },
    )
    task.signal.addEventListener("abort", () => void stop(child), { once: true })
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve)
      child.once("error", reject)
    })
    active.set("write-once", { child, closed })
    if (process.argv[2] === "stopped") await stop(child)
    const code = await closed
    active.delete("write-once")
    await host.operationFinish({
      id: "write-once",
      status:
        task.prompt === "hold-completed"
          ? "completed"
          : decision.signal.aborted || process.argv[2] === "stopped"
            ? "stopped"
            : code === 0
              ? "completed"
              : "failed",
    })
    finishBeforeCancelReceipt?.resolve()
    await fs.writeFile(path.join(task.cwd, "finished"), "FINISHED")
    return { text: code === 0 ? "DONE" : "FAILED" }
  },
})
