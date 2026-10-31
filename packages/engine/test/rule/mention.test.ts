import { SessionOperations } from "@merakcode/engine/app/session"
import { describe, expect, test } from "vitest"
import path from "path"
import { pathToFileURL } from "node:url"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { RuleSession } from "@merakcode/engine/agent/prompt/rules/session-state"
import { RulesPrompt } from "@merakcode/engine/agent/prompt/rules/prompt"
import { tmpdir } from "../fixture/fixture"
import { isolate, nativeRule } from "./isolate"

/**
 * Flips the drive letter case of a file:// URL to mimic a client path (c:) that differs from Glob (C:). URLs without
 * a drive letter are returned unchanged.
 */
function mentionFileUrl(filepath: string) {
  return pathToFileURL(filepath).href.replace(/^file:\/\/\/([A-Za-z]):/, (_, drive: string) => {
    const flipped = drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()
    return `file:///${flipped}:`
  })
}

describe("user @mention of a manual rule file", () => {
  test("injects the rule block instead of dumping the raw .mdc", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
            },
          },
        },
        init: (dir) =>
          nativeRule(dir, "review.mdc", "alwaysApply: false\nname: review", "每次回复末尾追加 MANUAL-REVIEW"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const filepath = path.join(tmp.path, ".merakcode", "rules", "review.mdc")
          const msg = await Loop.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [
              { type: "text", text: "请按这条规则评一下" },
              {
                type: "file",
                mime: "text/plain",
                url: mentionFileUrl(filepath),
                filename: "review.mdc",
              },
            ],
          })

          if (msg.info.role !== "user") throw new Error("expected user message")
          expect(
            msg.parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("MANUAL-REVIEW")),
          ).toBe(false)
          expect(msg.parts.some((part) => part.type === "text" && part.text.includes("Called the Read tool"))).toBe(
            false,
          )
          expect(msg.parts.some((part) => part.type === "file")).toBe(true)
          const pinned = await RuleSession.snapshot(session.id)
          expect(pinned.pinned.some((item) => item.filepath === filepath && item.source === "mention")).toBe(true)

          const active = await RulesPrompt.active({
            sessionID: session.id,
            agent: "build",
            messages: [{ info: msg.info, parts: msg.parts }],
          })
          expect(active.pinned.map((r) => r.name)).toEqual(["review"])
          expect(active.blocks.join("\n")).toContain("MANUAL-REVIEW")

          await SessionOperations.remove(session.id)
        },
      })
    })
  })

  test("does not dump an always-apply rule file as a read", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
            },
          },
        },
        init: (dir) => nativeRule(dir, "always.mdc", "alwaysApply: true", "ALWAYS-BODY"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const filepath = path.join(tmp.path, ".merakcode", "rules", "always.mdc")
          const msg = await Loop.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [
              { type: "text", text: "看一下这条 always 规则" },
              {
                type: "file",
                mime: "text/plain",
                url: mentionFileUrl(filepath),
                filename: "always.mdc",
              },
            ],
          })

          if (msg.info.role !== "user") throw new Error("expected user message")
          const texts = msg.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join("\n")
          expect(texts).not.toContain("Called the Read tool")
          expect(texts).not.toContain("ALWAYS-BODY")
          expect(msg.parts.some((part) => part.type === "file")).toBe(true)
          const pinned = await RuleSession.snapshot(session.id)
          expect(pinned.pinned).toEqual([])

          await SessionOperations.remove(session.id)
        },
      })
    })
  })

  test("pins an Apply Intelligently rule when the user @s the .mdc file", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
            },
          },
        },
        init: (dir) => nativeRule(dir, "rpc.mdc", "alwaysApply: false\nname: rpc\ndescription: RPC 约定", "RPC-BODY"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const filepath = path.join(tmp.path, ".merakcode", "rules", "rpc.mdc")
          await Loop.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [
              { type: "text", text: "按这条规则来" },
              {
                type: "file",
                mime: "text/plain",
                url: mentionFileUrl(filepath),
                filename: "rpc.mdc",
              },
            ],
          })
          const pinned = await RuleSession.snapshot(session.id)
          expect(pinned.pinned.some((item) => item.filepath === filepath && item.source === "mention")).toBe(true)
          const active = await RulesPrompt.active({ sessionID: session.id, agent: "build", messages: [] })
          expect(active.pinned.map((r) => r.name)).toEqual(["rpc"])
          expect(active.blocks.join("\n")).toContain("RPC-BODY")
          await SessionOperations.remove(session.id)
        },
      })
    })
  })
})

describe("session fork copies pinned rules", () => {
  test("sibling fork copies pins; child session does not", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "review.mdc", "alwaysApply: false\nname: review", "MANUAL-REVIEW"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const filepath = path.join(tmp.path, ".merakcode", "rules", "review.mdc")
          await RuleSession.pin(session.id, filepath, "mention")

          const sibling = await Session.fork({ sessionID: session.id })
          expect(sibling.rules?.pinned?.map((item) => item.filepath)).toEqual([filepath])
          const siblingSnap = await RuleSession.snapshot(sibling.id)
          expect(siblingSnap.pinned.map((item) => item.filepath)).toEqual([filepath])

          const child = await Session.forkAsChild({
            sessionID: session.id,
            parentID: session.id,
            title: "child",
          })
          expect(child.parentID).toBe(session.id)
          expect(child.rules?.pinned ?? []).toEqual([])
          const childSnap = await RuleSession.snapshot(child.id)
          expect(childSnap.pinned).toEqual([])

          await SessionOperations.remove(child.id)
          await SessionOperations.remove(sibling.id)
          await SessionOperations.remove(session.id)
        },
      })
    })
  })
})
