import { Provider } from "../provider/provider"

import { fn } from "../util/fn"
import z from "zod"
import { Session } from "."

import { Message } from "./message"
import { Identifier } from "@merakcode/util/id"
import { Snapshot } from "../snapshot"

import { Log } from "@merakcode/log/logger"
import { Storage } from "../storage/storage"
import { Bus } from "../bus"
import { diffLines } from "diff"

import { LLM } from "./llm"
import { Agent } from "../agent/agent"

export namespace SessionSummary {
  const log = Log.create({ service: "session.summary" })

  function unquoteGitPath(input: string) {
    if (!input.startsWith('"')) return input
    if (!input.endsWith('"')) return input
    const body = input.slice(1, -1)
    const bytes: number[] = []

    for (let i = 0; i < body.length; i++) {
      const char = body[i]!
      if (char !== "\\") {
        bytes.push(char.charCodeAt(0))
        continue
      }

      const next = body[i + 1]
      if (!next) {
        bytes.push("\\".charCodeAt(0))
        continue
      }

      if (next >= "0" && next <= "7") {
        const chunk = body.slice(i + 1, i + 4)
        const match = chunk.match(/^[0-7]{1,3}/)
        if (!match) {
          bytes.push(next.charCodeAt(0))
          i++
          continue
        }
        bytes.push(parseInt(match[0], 8))
        i += match[0].length
        continue
      }

      const escaped =
        next === "n"
          ? "\n"
          : next === "r"
            ? "\r"
            : next === "t"
              ? "\t"
              : next === "b"
                ? "\b"
                : next === "f"
                  ? "\f"
                  : next === "v"
                    ? "\v"
                    : next === "\\" || next === '"'
                      ? next
                      : undefined

      bytes.push((escaped ?? next).charCodeAt(0))
      i++
    }

    return Buffer.from(bytes).toString()
  }

  export const summarize = fn(
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
    }),
    async (input) => {
      const all = await Session.messages({ sessionID: input.sessionID })
      await Promise.all([
        summarizeSession({ sessionID: input.sessionID, messages: all }),
        summarizeMessage({ messageID: input.messageID, messages: all, sessionID: input.sessionID }),
      ])
    },
  )

  async function summarizeSession(input: { sessionID: string; messages: Message.FullMsg[] }) {
    const diffs = await computeDiff({ messages: input.messages, sessionID: input.sessionID })
    await Session.update(input.sessionID, (draft) => {
      draft.summary = {
        additions: diffs.reduce((sum, x) => sum + x.additions, 0),
        deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
        files: diffs.length,
      }
    })
    await Storage.write(["session_diff", input.sessionID], diffs)
    Bus.publish(Session.Event.Diff, {
      sessionID: input.sessionID,
      diff: diffs,
    })
  }

  async function summarizeMessage(input: { messageID: string; messages: Message.FullMsg[]; sessionID: string }) {
    const messages = input.messages.filter(
      (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
    )
    const fullMsg = messages.find((m) => m.info.id === input.messageID)!
    if (Message.isExternal(fullMsg.info)) return
    const userInfo = fullMsg.info as Message.UserInfo
    const diffs = await computeDiff({ messages, sessionID: input.sessionID })
    userInfo.summary = {
      ...userInfo.summary,
      diffs,
    }
    await Session.updateInfo(userInfo)

    const textPart = fullMsg.parts.find((p) => p.type === "text" && !p.synthetic) as Message.TextPart
    if (textPart && !userInfo.summary?.title) {
      const agent = await Agent.get("title")
      if (!agent) return
      const stream = await LLM.stream({
        agent,
        user: userInfo,
        tools: {},
        model: agent.model
          ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
          : ((await Provider.getSmallModel(userInfo.model.providerID)) ??
            (await Provider.getModel(userInfo.model.providerID, userInfo.model.modelID))),
        small: true,
        messages: [
          {
            role: "user" as const,
            content: `
              The following is the text to summarize:
              <text>
              ${textPart?.text ?? ""}
              </text>
            `,
          },
        ],
        abort: new AbortController().signal,
        sessionID: userInfo.sessionID,
        system: [],
        retries: 3,
      })
      // Title generation is auxiliary: skip silently on failure so a failed small-model stream never breaks the
      // session. Same fallback as title generation in runner.ts.
      const result = await Promise.resolve(stream.text).catch((err) =>
        log.error("failed to generate title", { error: err }),
      )
      if (!result) return
      log.info("title", { title: result })
      userInfo.summary.title = result
      await Session.updateInfo(userInfo)
    }
  }

  export const diff = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
    }),
    async (input) => {
      const diffs = await Storage.read<Snapshot.FileDiff[]>(["session_diff", input.sessionID]).catch(() => [])
      const next = diffs.map((item) => {
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return {
          ...item,
          file,
        }
      })
      const changed = next.some((item, i) => item.file !== diffs[i]?.file)
      if (changed) Storage.write(["session_diff", input.sessionID], next).catch(() => {})
      return next
    },
  )

  export async function computeDiff(input: { messages: Message.FullMsg[]; sessionID?: string }) {
    let from: string | undefined
    const pairs: { from: string; to: string }[] = []

    // Each step's backup only contains the files that step touched, so the first start cannot be compared with the
    // last finish directly: a later step-finish without file changes has an empty backup and would hide real edits.
    for (const item of input.messages) {
      for (const part of item.parts) {
        if (part.type === "step-start" && part.snapshot) from = part.snapshot
        if (part.type !== "step-finish" || !part.snapshot || !from) continue
        pairs.push({ from, to: part.snapshot })
        from = undefined
      }
    }

    const merged = new Map<string, Snapshot.FileDiff>()
    for (const pair of pairs) {
      for (const item of await Snapshot.diffFull(pair.from, pair.to, input.sessionID ?? "")) {
        const previous = merged.get(item.file)
        const before = previous?.before ?? item.before
        const beforeExists = (previous ?? item).status !== "added"
        const afterExists = item.status !== "deleted"
        if (before === item.after && beforeExists === afterExists) {
          merged.delete(item.file)
          continue
        }
        const changes = diffLines(before, item.after)
        merged.set(item.file, {
          file: item.file,
          before,
          after: item.after,
          additions: changes.reduce((total, change) => total + (change.added ? (change.count ?? 0) : 0), 0),
          deletions: changes.reduce((total, change) => total + (change.removed ? (change.count ?? 0) : 0), 0),
          status: !beforeExists ? "added" : !afterExists ? "deleted" : "modified",
        })
      }
    }
    return [...merged.values()]
  }
}
