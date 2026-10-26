import z from "zod"
import path from "path"
import { Identifier } from "@merakcode/util/id"
import { Snapshot } from "../snapshot"
import { Message } from "./message"
import { Session } from "."
import { Log } from "@merakcode/log/logger"
import { Storage } from "../storage/storage"
import { Bus } from "../bus"
import { SessionRunner } from "./runner"
import { Instance } from "../project/instance"
import { NamedError } from "@merakcode/util/error"
import { Text } from "../util/text"
import { SessionRevert } from "./revert"

/**
 * Multi-level undo/redo.
 *
 * undo: return to the state before a message, hide the later messages and push onto undoRedo.stack.
 * redo: pop the top entry and restore the state from before that undo.
 * discard: drop redo history after a new message is sent, permanently deleting the hidden messages.
 */
export namespace SessionUndoRedo {
  const log = Log.create({ service: "session.undo-redo" })

  /**
   * Typed undo failure carrying a user-readable reason and an optional list of files that failed to roll back.
   * It reaches the client intact through server onError, err.toObject() and SDK error.data, so the dialog can show
   * the real reason instead of a generic failure. Error.message is always the class name; the reason is in
   * data.message.
   */
  export const RevertFailedError = NamedError.create(
    "RevertFailedError",
    z.object({
      message: z.string(),
      /** Absolute paths that failed to roll back (file in use or no permission), so the user can retry */
      failedFiles: z.array(z.string()).optional(),
    }),
  )

  export const RevertInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message"),
    /** Whether to restore files to the undo point; defaults to true */
    revertFiles: z.boolean().optional().default(true),
  })
  export type RevertInput = z.infer<typeof RevertInput>

  /**
   * Returns the session to the state before the target message.
   */
  export async function undo(input: RevertInput) {
    return SessionRevert.inCheckout(input.sessionID, () => undoInCheckout(input))
  }

  async function undoInCheckout(input: RevertInput) {
    // Undo takes priority: cancel the whole session tree (foreground, background workflow/bash and child sessions)
    // instead of only asserting not busy. This avoids BusyError afterwards and stops background tasks from changing
    // files after the rollback.
    await SessionRunner.cancelTree(input.sessionID)

    const session = await Session.get(input.sessionID)

    // Read every message, bypassing the hiddenMessages filter in messages()
    const allMessages: Message.FullMsg[] = []
    for await (const msg of Message.stream(input.sessionID)) {
      allMessages.push(msg)
    }
    allMessages.reverse()

    // allMessages is ordered oldest first
    const targetIndex = allMessages.findIndex((msg) => msg.info.id === input.messageID)
    if (targetIndex === -1)
      throw new RevertFailedError({
        message: await Text.pick(
          {
            zh: "找不到要撤回的消息：{id}（可能已被清理或撤回）",
            en: "Message to undo not found: {id} (it may have been cleaned up or already undone)",
          },
          { id: input.messageID },
        ),
      })

    // Collect every PatchPart from the target message onwards
    const patches: Snapshot.Patch[] = []
    const filesToBackup = new Set<string>()
    for (let i = targetIndex; i < allMessages.length; i++) {
      const msg = allMessages[i]
      for (const part of msg.parts) {
        if (part.type === "patch") {
          const patchPart = part as Message.PatchPart
          patches.push({
            backupID: patchPart.backupID,
            files: patchPart.files,
            additions: patchPart.additions,
            deletions: patchPart.deletions,
          })
          for (const file of patchPart.files) {
            filesToBackup.add(file)
          }
        }
      }
    }

    // Back up the current files for redo; skipped when only the conversation is undone
    const revertFiles = input.revertFiles ?? true
    let fileSnapshot = ""
    if (revertFiles) {
      fileSnapshot = await Snapshot.track(input.sessionID)
      if (fileSnapshot && filesToBackup.size > 0) {
        await Snapshot.backupCurrentFiles(fileSnapshot, input.sessionID, Array.from(filesToBackup))
      }
    }

    // Restore files to the state before the target message. This throws before messages are hidden and undoRedo is
    // written. Revert works file by file, so files that succeeded stay rolled back, but messages and the undoRedo
    // stack are unchanged. Retrying after the user closes the blocking program is idempotent, and we never end up
    // with a partial rollback plus hidden messages.
    if (revertFiles && patches.length > 0) {
      const { failed } = await Snapshot.revert(patches, input.sessionID)
      if (failed.length > 0) {
        throw new RevertFailedError({
          message: await Text.pick(
            {
              zh: "以下 {count} 个文件回滚失败（可能被其它程序占用或权限不足），请关闭占用后重试：\n{files}",
              en: "Failed to roll back {count} file(s) (they may be in use by another program or lack permissions). Close whatever is using them and retry:\n{files}",
            },
            { count: failed.length, files: failed.map((f) => path.relative(Instance.worktree, f)).join("\n") },
          ),
          failedFiles: failed,
        })
      }
    }

    const hiddenMessages = allMessages.slice(targetIndex).map((msg) => msg.info.id)

    // Copy the array so the stored stack is not mutated in place
    const stack = [...(session.undoRedo?.stack ?? [])]
    stack.push({
      hiddenMessages,
      fileSnapshot,
      targetMessageID: input.messageID,
      timestamp: Date.now(),
    })

    await Session.update(input.sessionID, (draft) => {
      draft.undoRedo = { stack }
      draft.revert = undefined
    })

    await refreshDiff(input.sessionID)

    log.info("undo completed", {
      sessionID: input.sessionID,
      targetMessageID: input.messageID,
      hiddenCount: hiddenMessages.length,
    })

    await Session.touch(input.sessionID).catch(() => {})
    return Session.get(input.sessionID)
  }

  /**
   * Reverts the most recent undo.
   */
  export async function redo(input: { sessionID: string }) {
    return SessionRevert.inCheckout(input.sessionID, () => redoInCheckout(input))
  }

  async function redoInCheckout(input: { sessionID: string }) {
    SessionRunner.assertNotBusy(input.sessionID)

    const session = await Session.get(input.sessionID)
    const stack = [...(session.undoRedo?.stack ?? [])]
    if (stack.length === 0) throw new Error(await Text.pick({ zh: "没有可恢复的操作", en: "Nothing to redo" }))

    const entry = stack.pop()!

    if (entry.fileSnapshot) {
      await Snapshot.restore(entry.fileSnapshot, input.sessionID)
    }

    await Session.update(input.sessionID, (draft) => {
      draft.undoRedo = { stack }
    })

    await refreshDiff(input.sessionID)

    log.info("redo completed", {
      sessionID: input.sessionID,
      remainingStack: stack.length,
    })

    await Session.touch(input.sessionID).catch(() => {})
    return Session.get(input.sessionID)
  }

  /**
   * Drops redo history after a new message is sent.
   * Permanently deletes all hidden messages and clears undoRedo.stack.
   */
  export async function discard(input: { sessionID: string; projectID?: string }) {
    const session = input.projectID
      ? await Session.getByProject({ id: input.sessionID, projectID: input.projectID })
      : await Session.get(input.sessionID)
    const stack = session.undoRedo?.stack ?? []
    if (stack.length === 0) return

    const allHidden = new Set<string>()
    for (const entry of stack) {
      for (const msgID of entry.hiddenMessages) {
        allHidden.add(msgID)
      }
    }

    for (const messageID of allHidden) {
      await Session.removeMessage({ sessionID: input.sessionID, messageID })
    }

    // updateByProject avoids Storage.NotFoundError when the projectID differs from the current one
    if (input.projectID) {
      await Session.updateByProject(input.sessionID, input.projectID, (draft) => {
        draft.undoRedo = undefined
      })
    } else {
      await Session.update(input.sessionID, (draft) => {
        draft.undoRedo = undefined
      })
    }

    log.info("discard completed", {
      sessionID: input.sessionID,
      deletedCount: allHidden.size,
    })
  }

  /**
   * Returns files modified manually since the backup.
   */
  export async function checkManualChanges(sessionID: string, backupID: string): Promise<string[]> {
    if (!backupID) return []
    return Snapshot.checkManualChanges(backupID, sessionID)
  }

  /**
   * Recomputes and stores the session diff summary.
   */
  async function refreshDiff(sessionID: string) {
    try {
      const visibleMessages = await Session.messages({ sessionID })
      const diffs = await computeVisibleDiff(visibleMessages, sessionID)
      await Storage.write(["session_diff", sessionID], diffs)
      await Session.update(sessionID, (draft) => {
        draft.summary = {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        }
      })
      Bus.publish(Session.Event.Diff, { sessionID, diff: diffs })
    } catch (e) {
      log.warn("failed to refresh diff", { error: String(e) })
    }
  }

  /**
   * Computes the diff of visible messages without SessionSummary, to avoid a circular dependency.
   */
  async function computeVisibleDiff(messages: Message.FullMsg[], sessionID: string): Promise<Snapshot.FileDiff[]> {
    let from: string | undefined
    let to: string | undefined

    for (const msg of messages) {
      if (!from) {
        for (const part of msg.parts) {
          if (part.type === "step-start" && part.snapshot) {
            from = part.snapshot
            break
          }
        }
      }
      for (const part of msg.parts) {
        if (part.type === "step-finish" && part.snapshot) {
          to = part.snapshot
        }
      }
    }

    if (from && to) return Snapshot.diffFull(from, to, sessionID)
    return []
  }
}
