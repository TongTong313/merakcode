import { adapter } from "@merakcode/sdk/adapter"
import fs from "node:fs"
import path from "node:path"

adapter({
  inspect: () => ({
    name: "Lock fixture",
    capabilities: {
      modelSelection: false,
      modelDiscovery: false,
      textStreaming: true,
      resume: false,
      permission: "external",
      questions: false,
    },
  }),
  async run(task, host) {
    const active = path.join(task.cwd, "external-active")
    if (task.prompt.startsWith("hold:")) {
      fs.writeFileSync(active, "active")
      host.textDelta({ messageID: "reply", partID: "text", delta: "holding" })
      try {
        while (!fs.existsSync(task.prompt.slice(5))) {
          task.signal.throwIfAborted()
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        const text = fs.existsSync(path.join(task.cwd, "native-write")) ? "native-overlap" : "released"
        return { text, final: { messageID: "reply", parts: [{ partID: "text", text }] } }
      } finally {
        fs.rmSync(active, { force: true })
      }
    }
    return { text: fs.existsSync(active) ? "overlap" : "serialized" }
  },
})
