import { describe, expect, test } from "vitest"
import path from "path"
import { chmod } from "fs/promises"
import { Session } from "@merakcode/engine/session/index"
import { SessionUndoRedo } from "@merakcode/engine/session/undo-redo"
import { Message } from "@merakcode/engine/session/message"
import { Snapshot } from "@merakcode/engine/snapshot/index"
import { Log } from "@merakcode/log/logger"
import { Instance } from "@merakcode/engine/project/instance"
import { Identifier } from "@merakcode/util/id"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

Log.init({ print: false })

describe("SessionUndoRedo.revertFiles", () => {
  test("revertFiles=false hides messages without restoring files", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "a.txt")
        await Filesystem.write(filePath, "ORIGINAL")

        const session = await Session.create({})
        const sessionID = session.id

        const userMsg = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: { providerID: "openai", modelID: "gpt-4" },
          time: { created: Date.now() },
        })

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg.id,
          sessionID,
          type: "text",
          text: "edit file",
        })

        const backupID = await Snapshot.track(sessionID)
        await Snapshot.trackFile(filePath, sessionID)
        await Filesystem.write(filePath, "MODIFIED")

        const assistantMsg: Message.AssistantInfo = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: userMsg.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        await Session.updateInfo(assistantMsg)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg.id,
          sessionID,
          type: "patch",
          backupID,
          files: [filePath],
          additions: 1,
          deletions: 0,
        })

        await SessionUndoRedo.undo({ sessionID, messageID: userMsg.id, revertFiles: false })

        expect(await Filesystem.readText(filePath)).toBe("MODIFIED")

        const visible = await Session.messages({ sessionID })
        expect(visible.some((m) => m.info.id === userMsg.id)).toBe(false)

        await Session.remove(sessionID)
      },
    })
  })

  test("undo then redo makes messages visible again and restores files to their pre-undo state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "a.txt")
        await Filesystem.write(filePath, "ORIGINAL")

        const session = await Session.create({})
        const sessionID = session.id

        const userMsg = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: { providerID: "openai", modelID: "gpt-4" },
          time: { created: Date.now() },
        })

        const backupID = await Snapshot.track(sessionID)
        await Snapshot.trackFile(filePath, sessionID)
        await Filesystem.write(filePath, "MODIFIED")

        const assistantMsg: Message.AssistantInfo = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: userMsg.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        await Session.updateInfo(assistantMsg)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg.id,
          sessionID,
          type: "patch",
          backupID,
          files: [filePath],
          additions: 1,
          deletions: 0,
        })

        await SessionUndoRedo.undo({ sessionID, messageID: userMsg.id, revertFiles: true })
        expect((await Session.messages({ sessionID })).length).toBe(0)
        expect(await Filesystem.readText(filePath)).toBe("ORIGINAL")

        await SessionUndoRedo.redo({ sessionID })
        const visible = await Session.messages({ sessionID })
        expect(visible.some((m) => m.info.id === userMsg.id)).toBe(true)
        expect(await Filesystem.readText(filePath)).toBe("MODIFIED")

        await Session.remove(sessionID)
      },
    })
  })

  test("redo after undo restores files in a non-git workspace", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "hello.html")
        await Filesystem.write(filePath, "ORIGINAL")

        const session = await Session.create({})
        const sessionID = session.id

        const userMsg = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: { providerID: "openai", modelID: "gpt-4" },
          time: { created: Date.now() },
        })

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg.id,
          sessionID,
          type: "text",
          text: "create file",
        })

        const backupID = await Snapshot.track(sessionID)
        await Snapshot.trackFile(filePath, sessionID)
        await Filesystem.write(filePath, "MODIFIED")

        const assistantMsg: Message.AssistantInfo = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: userMsg.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        await Session.updateInfo(assistantMsg)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg.id,
          sessionID,
          type: "patch",
          backupID,
          files: [filePath],
          additions: 1,
          deletions: 0,
        })

        await SessionUndoRedo.undo({ sessionID, messageID: userMsg.id, revertFiles: true })
        expect(await Filesystem.readText(filePath)).toBe("ORIGINAL")

        await SessionUndoRedo.redo({ sessionID })
        expect(await Filesystem.readText(filePath)).toBe("MODIFIED")

        await Session.remove(sessionID)
      },
    })
  })

  test("undo deletes a file the agent created", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const newFile = path.join(tmp.path, "new.txt")

        const session = await Session.create({})
        const sessionID = session.id

        const userMsg = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: { providerID: "openai", modelID: "gpt-4" },
          time: { created: Date.now() },
        })

        const backupID = await Snapshot.track(sessionID)
        await Snapshot.trackFile(newFile, sessionID) // file doesn't exist yet, so reverting it means deleting it
        await Filesystem.write(newFile, "NEW")

        const assistantMsg: Message.AssistantInfo = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: userMsg.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        await Session.updateInfo(assistantMsg)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg.id,
          sessionID,
          type: "patch",
          backupID,
          files: [newFile],
          additions: 1,
          deletions: 0,
        })

        await SessionUndoRedo.undo({ sessionID, messageID: userMsg.id, revertFiles: true })

        expect(await Filesystem.isFile(newFile)).toBe(false)

        await Session.remove(sessionID)
      },
    })
  })

  test("undo of a read-only created file keeps it, throws RevertFailedError, and succeeds once writable", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const newFile = path.join(tmp.path, "readonly-new.txt")

        const session = await Session.create({})
        const sessionID = session.id

        const userMsg = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: { providerID: "openai", modelID: "gpt-4" },
          time: { created: Date.now() },
        })

        const backupID = await Snapshot.track(sessionID)
        await Snapshot.trackFile(newFile, sessionID)
        await Filesystem.write(newFile, "NEW")

        const assistantMsg: Message.AssistantInfo = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: userMsg.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        await Session.updateInfo(assistantMsg)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg.id,
          sessionID,
          type: "patch",
          backupID,
          files: [newFile],
          additions: 1,
          deletions: 0,
        })

        await chmod(newFile, 0o444)
        try {
          let caught: any
          try {
            await SessionUndoRedo.undo({ sessionID, messageID: userMsg.id, revertFiles: true })
          } catch (e) {
            caught = e
          }

          expect(SessionUndoRedo.RevertFailedError.isInstance(caught)).toBe(true)
          expect(caught.data.failedFiles).toContain(newFile)
          expect(await Filesystem.isFile(newFile)).toBe(true)
          expect(await Filesystem.readText(newFile)).toBe("NEW")
          const visible = await Session.messages({ sessionID })
          expect(visible.some((m) => m.info.id === userMsg.id)).toBe(true)

          await chmod(newFile, 0o644)
          await SessionUndoRedo.undo({ sessionID, messageID: userMsg.id, revertFiles: true })
          expect(await Filesystem.isFile(newFile)).toBe(false)
        } finally {
          await chmod(newFile, 0o644).catch(() => {})
        }

        await Session.remove(sessionID)
      },
    })
  })

  test("one failed file revert still reverts the others, reports failedFiles, and leaves the session retryable", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const okFile = path.join(tmp.path, "ok.txt")
        const badPath = path.join(tmp.path, "bad") // becomes a directory later so the revert's unlink throws
        await Filesystem.write(okFile, "ORIGINAL")

        const session = await Session.create({})
        const sessionID = session.id

        const userMsg = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: { providerID: "openai", modelID: "gpt-4" },
          time: { created: Date.now() },
        })

        const backupID = await Snapshot.track(sessionID)
        await Snapshot.trackFile(okFile, sessionID)
        await Snapshot.trackFile(badPath, sessionID) // badPath doesn't exist yet, so reverting it means deleting it
        await Filesystem.write(okFile, "MODIFIED")
        // A non-empty directory at badPath makes the delete-created-file branch's fs.unlink throw EISDIR/EPERM.
        const { mkdir } = await import("fs/promises")
        await mkdir(badPath, { recursive: true })
        await Filesystem.write(path.join(badPath, "child.txt"), "x")

        const assistantMsg: Message.AssistantInfo = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: userMsg.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        await Session.updateInfo(assistantMsg)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg.id,
          sessionID,
          type: "patch",
          backupID,
          files: [okFile, badPath],
          additions: 1,
          deletions: 0,
        })

        let caught: any
        try {
          await SessionUndoRedo.undo({ sessionID, messageID: userMsg.id, revertFiles: true })
        } catch (e) {
          caught = e
        }

        // The typed error lists the failed files so the client can ask the user to close them and retry.
        expect(SessionUndoRedo.RevertFailedError.isInstance(caught)).toBe(true)
        expect(caught.data.failedFiles).toContain(badPath)
        // A single failure doesn't abandon the other files.
        expect(await Filesystem.readText(okFile)).toBe("ORIGINAL")
        // Nothing is committed on failure: the message stays visible so the undo can be retried.
        const visible = await Session.messages({ sessionID })
        expect(visible.some((m) => m.info.id === userMsg.id)).toBe(true)

        await Session.remove(sessionID)
      },
    })
  })

  test("undo of an unknown messageID throws RevertFailedError with the reason in data.message", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        let caught: any
        try {
          await SessionUndoRedo.undo({
            sessionID: session.id,
            messageID: Identifier.ascending("message"),
            revertFiles: false,
          })
        } catch (e) {
          caught = e
        }
        expect(caught).toBeDefined()
        // The reason must travel in a typed NamedError so the client dialog shows it instead of a generic failure.
        expect(SessionUndoRedo.RevertFailedError.isInstance(caught)).toBe(true)
        expect(caught.data.message).toMatch(/找不到要撤回的消息/)

        await Session.remove(session.id)
      },
    })
  })

  test("revertFiles=true restores files and hides messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "a.txt")
        await Filesystem.write(filePath, "ORIGINAL")

        const session = await Session.create({})
        const sessionID = session.id

        const userMsg = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: { providerID: "openai", modelID: "gpt-4" },
          time: { created: Date.now() },
        })

        const backupID = await Snapshot.track(sessionID)
        await Snapshot.trackFile(filePath, sessionID)
        await Filesystem.write(filePath, "MODIFIED")

        const assistantMsg: Message.AssistantInfo = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: userMsg.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        await Session.updateInfo(assistantMsg)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg.id,
          sessionID,
          type: "patch",
          backupID,
          files: [filePath],
          additions: 1,
          deletions: 0,
        })

        await SessionUndoRedo.undo({ sessionID, messageID: userMsg.id, revertFiles: true })

        expect(await Filesystem.readText(filePath)).toBe("ORIGINAL")

        await Session.remove(sessionID)
      },
    })
  })
})
