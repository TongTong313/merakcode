import type { ChildProcess } from "node:child_process"

/** Request a graceful close and require a normal process exit within the deadline. */
export function closeProcess(child: ChildProcess, request: () => Promise<unknown>, timeout = 30_000) {
  return new Promise<void>((resolve, reject) => {
    let requestError: unknown
    const cleanup = () => {
      clearTimeout(timer)
      child.off("exit", exited)
    }
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      code === 0 ? resolve() : reject(new Error(`Packaged app exited with ${signal ?? code}`, { cause: requestError }))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("Packaged app did not exit after closing", { cause: requestError }))
    }, timeout)
    child.once("exit", exited)
    if (child.exitCode !== null || child.signalCode !== null) return exited(child.exitCode, child.signalCode)
    void Promise.resolve()
      .then(request)
      .catch((error: unknown) => {
        requestError = error
      })
  })
}
