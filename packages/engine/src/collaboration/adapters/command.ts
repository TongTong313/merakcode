/**
 * Built-in member adapter for a one-shot command: a CLI that takes the prompt on stdin, works to the end and prints
 * its reply. It cannot ask anything, so approvals and questions are its own settings' business. A session line, when
 * set, picks the CLI's session out of the output, and resume arguments continue it next time.
 */
import { adapter, spawn, stop, type Product } from "@merakcode/sdk/adapter"

/** Arguments for a task: resume arguments when there is a session to continue, with {id} replaced by it */
function commandArgs(product: Product, resume?: string) {
  const template = resume && product.resumeArgs ? product.resumeArgs : (product.args ?? [])
  return template.map((arg) => (arg === "{id}" ? (resume ?? "") : arg))
}

/** All of the output is the reply, except the line that carries the session id */
function parseText(stdout: string, sessionLine?: string) {
  const match = sessionLine ? new RegExp(sessionLine, "m").exec(stdout) : null
  if (!match) return { text: stdout.trim() }
  return {
    text: stdout
      .replace(match[0], "")
      .replace(/\n{2,}/g, "\n")
      .trim(),
    sessionId: match[1],
  }
}

adapter({
  // A command may not know --version and would start working instead: MerakCode has found it, which is all there is
  inspect: (product) => ({ name: product.title, path: product.command }),
  async run(task) {
    const child = spawn(task.product.command ?? "", commandArgs(task.product, task.resume), {
      cwd: task.cwd,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    })
    task.signal.addEventListener("abort", () => void stop(child), { once: true })
    let stdout = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    const ended = new Promise<number>((resolve) => {
      child.once("close", (code) => resolve(code ?? -1))
      child.once("error", () => resolve(-1))
    })
    child.stdin.end(task.prompt)
    try {
      const code = await ended
      if (task.signal.aborted) throw new Error(`${task.product.title} was stopped`)
      const parsed = parseText(stdout, task.product.sessionLine)
      if (!parsed.text) throw new Error(`${task.product.title} returned no reply (exit code ${code})`)
      return parsed
    } finally {
      await stop(child)
    }
  },
})
