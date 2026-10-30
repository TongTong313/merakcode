/**
 * Built-in member adapter for a one-shot command: a CLI that takes the prompt on stdin, works to the end and prints
 * its reply. It cannot ask anything, so approvals and questions are its own settings' business. A session line, when
 * set, picks the CLI's session out of the output, and resume arguments continue it next time.
 */
import { adapter, spawn, stop, type Product, type ProductModel } from "@merakcode/sdk/adapter"

function supportsResume(product: Product) {
  return !!product.sessionLine && !!product.resumeArgs
}

/** Arguments for a task: resume arguments when there is a session to continue, with {id} replaced by it */
function commandArgs(product: Product, resume?: string, model?: ProductModel) {
  const template = resume && product.resumeArgs ? product.resumeArgs : (product.args ?? [])
  if (model && !template.includes("{model}")) throw new Error("The command has no model argument placeholder")
  if (!model && template.includes("{model}")) throw new Error("The command requires a configured model")
  return template.map((arg) => (arg === "{id}" ? (resume ?? "") : arg === "{model}" ? model!.id : arg))
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
  inspect: (product) => ({
    name: product.title,
    path: product.command,
    capabilities: {
      modelSelection: (product.args ?? []).includes("{model}"),
      modelDiscovery: false,
      textStreaming: false,
      resume: supportsResume(product),
      permission: "external",
      questions: false,
    },
  }),
  async run(task, host) {
    const resumable = supportsResume(task.product)
    const child = spawn(task.product.command ?? "", commandArgs(task.product, task.resume, task.model), {
      cwd: task.cwd,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    })
    task.signal.addEventListener("abort", () => void stop(child), { once: true })
    let stdout = ""
    let reported: Promise<void> | undefined
    const reportSession = (text: string) => {
      if (reported || !resumable || !task.product.sessionLine) return
      const id = new RegExp(task.product.sessionLine, "m").exec(text)?.[1]
      if (!id) return
      reported = host.sessionStarted({ sessionId: id })
      void reported.catch(() => {})
    }
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      const end = stdout.lastIndexOf("\n")
      if (end >= 0) reportSession(stdout.slice(0, end + 1))
    })
    const ended = new Promise<number>((resolve) => {
      child.once("close", (code) => resolve(code ?? -1))
      child.once("error", () => resolve(-1))
    })
    child.stdin.end(task.prompt)
    try {
      const code = await ended
      if (!task.signal.aborted) reportSession(stdout)
      await reported
      if (task.signal.aborted) throw new Error(`${task.product.title} was stopped`)
      if (code !== 0) throw new Error(`${task.product.title} failed (exit code ${code})`)
      const parsed = parseText(stdout, task.product.sessionLine)
      if (!parsed.text) throw new Error(`${task.product.title} returned no reply (exit code ${code})`)
      return resumable ? parsed : { text: parsed.text }
    } finally {
      await stop(child)
    }
  },
})
