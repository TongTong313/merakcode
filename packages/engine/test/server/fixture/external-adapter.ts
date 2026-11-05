import { adapter } from "@merakcode/sdk/adapter"
import { randomUUID } from "node:crypto"
import fs from "node:fs"

adapter({
  inspect: async () => {
    if (["inspect-gate", "plan-gate"].includes(process.argv[2] ?? "")) {
      const gate = process.argv[3]!
      fs.writeFileSync(`${gate}.started`, "ready")
      while (!fs.existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return {
      name: "External fixture",
      capabilities: {
        modelSelection: true,
        modelDiscovery: false,
        textStreaming: true,
        resume: true,
        permission: "merak",
        control: {
          reportedOperations: ["read", "write", "command", "network", "tool"],
          cancellation: "task",
          liveMode: true,
          limitations: [],
        },
        questions: true,
        draftOnly: true,
        plan: {
          fullInput: true,
          contextTokens:
            process.argv[2] === "plan-capacity" ? Number(fs.readFileSync(process.argv[3]!, "utf8")) : 200000,
          reservedTokens: 1000,
          fixedInputTokens: 100,
        },
      },
    }
  },
  async run(task, host) {
    if (["plan-input", "plan-capacity"].includes(process.argv[2] ?? "")) {
      const verdict =
        process.argv[5] === "verify-paused"
          ? await host.permission({ kind: "write", paths: ["paused-write.txt"] }).catch(() => ({ allow: false }))
          : undefined
      if (verdict?.allow) fs.writeFileSync(`${task.cwd}/paused-write.txt`, "CHANGED")
      fs.writeFileSync(
        process.argv[2] === "plan-capacity" ? process.argv[4]! : process.argv[3]!,
        JSON.stringify({ ...task, writeAllowed: verdict?.allow }),
      )
      return { text: "Plan received" }
    }
    if (process.argv[2] === "plan-gate") {
      fs.writeFileSync(`${process.argv[3]}.received`, JSON.stringify(task))
      return { text: "Plan received" }
    }
    if (process.argv[2] === "scope-gate") {
      if (task.scope !== "draft") return { text: "Later task complete" }
      const gate = process.argv[3]!
      fs.writeFileSync(`${gate}.started`, "ready")
      while (!fs.existsSync(gate)) {
        task.signal.throwIfAborted()
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const verdict = await host.permission({ kind: "write", paths: ["effect.txt"] }).catch(() => ({ allow: false }))
      if (verdict.allow) fs.writeFileSync(`${task.cwd}/effect.txt`, "CHANGED")
      return { text: verdict.allow ? "ALLOWED" : "DENIED" }
    }
    const initialMode = task.permissionLevel
    const sessionId = task.resume ?? randomUUID()
    await host.sessionStarted({ sessionId })
    if (process.argv[2] === "mode-at-start") {
      const gate = task.prompt.startsWith("gate:") ? task.prompt.slice(5) : undefined
      if (gate) fs.writeFileSync(`${gate}.started`, "ready")
      while (gate && !fs.existsSync(gate)) {
        task.signal.throwIfAborted()
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return { text: `started:${initialMode}`, sessionId }
    }
    if (process.argv[2] === "pending-permission") {
      const verdict = await host.permission({ kind: "write", paths: [`${process.argv[3]}/file.ts`] })
      return { text: `Permission ${verdict.allow ? "allowed" : "denied"}`, sessionId }
    }
    if (process.argv[2] === "pending-question") {
      const answers = await host.question([
        {
          header: "Decision",
          question: `Continue member ${process.argv[3]}?`,
          options: [{ label: "Proceed", description: "Continue this member's task" }],
        },
      ])
      return { text: `Question answered: ${answers[0]?.join(", ")}`, sessionId }
    }
    if (task.prompt === "show a step") host.step({ tool: "Read", detail: "README.md" })
    const text =
      process.argv[2] === "final-text" || process.argv[2] === "final-parts"
        ? "Hello world"
        : task.prompt === "ask to write"
          ? `allow:${(await host.permission({ kind: "write", paths: ["file.ts"] })).allow}`
          : `Hello world (${sessionId}; ${task.model?.id ?? "fixture-default"})`
    if (process.argv[2] === "final-parts")
      host.textDelta({ messageID: "earlier", partID: "text", delta: "Earlier commentary" })
    host.textDelta({ messageID: "reply", partID: "text", delta: "Hello " })
    if (["final-text", "final-parts"].includes(process.argv[2] ?? "") && process.argv[3] === "2")
      host.textDelta({ messageID: "reply", partID: "tail", delta: "stale tail" })
    while (task.prompt.startsWith("gate:") && !fs.existsSync(task.prompt.slice(5))) {
      task.signal.throwIfAborted()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (process.argv[2] === "final-text") return { text: process.argv[4] === "empty" ? "" : text, sessionId }
    if (process.argv[2] === "final-parts")
      return {
        text,
        sessionId,
        final: {
          messageID: "reply",
          parts:
            process.argv[4] === "empty"
              ? []
              : [
                  {
                    partID: "text",
                    text: process.argv[4] === "blank" ? "" : process.argv[4] === "whitespace" ? " \n\t" : text,
                  },
                ],
        },
      }
    host.textDelta({ messageID: "reply", partID: "text", delta: text.slice(6) })
    return {
      text,
      sessionId,
      actualModel: { id: task.model?.id ?? "fixture-default" },
      final: { messageID: "reply", parts: [{ partID: "text", text }] },
    }
  },
})
