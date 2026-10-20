import z from "zod"
import { Identifier } from "@merakcode/util/id"
import { Snapshot } from "../snapshot"
import { Message } from "./message"
import { Transcript } from "./transcript"
import { Session } from "."
import { Log } from "@merakcode/log/logger"
import { splitWhen } from "remeda"
import { Storage } from "../storage/storage"
import { Bus } from "../bus"
import { SessionRunner } from "./runner"
import { SessionSummary } from "./summary"

export namespace SessionRevert {
  const log = Log.create({ service: "session.revert" })

  export const RevertInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message"),
    partID: Identifier.schema("part").optional(),
  })
  export type RevertInput = z.infer<typeof RevertInput>

  export async function revert(input: RevertInput) {
    SessionRunner.assertNotBusy(input.sessionID)
    const all = await Session.messages({ sessionID: input.sessionID })
    let lastUserInfo: Message.UserInfo | undefined
    const session = await Session.get(input.sessionID)

    let revert: Session.Info["revert"]
    const patches: Snapshot.Patch[] = []
    for (const fullMsg of all) {
      if (fullMsg.info.role === "user") lastUserInfo = fullMsg.info
      const remaining = []
      for (const part of fullMsg.parts) {
        if (revert) {
          if (part.type === "patch") {
            patches.push(part as Snapshot.Patch)
          }
          continue
        }

        if (!revert) {
          if ((fullMsg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
            // if no useful parts left in message, same as reverting whole message
            const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
            revert = {
              messageID: !partID && lastUserInfo ? lastUserInfo.id : fullMsg.info.id,
              partID,
            }
          }
          remaining.push(part)
        }
      }
    }

    if (revert) {
      const session = await Session.get(input.sessionID)
      revert.snapshot = session.revert?.snapshot ?? (await Snapshot.track(input.sessionID))
      if (revert.snapshot) {
        await Snapshot.revert(patches, input.sessionID)
        revert.diff = await Snapshot.diff(revert.snapshot, input.sessionID)
      }
      const rangeMessages = all.filter((msg) => msg.info.id >= revert!.messageID)
      const diffs = await SessionSummary.computeDiff({ messages: rangeMessages, sessionID: input.sessionID })
      await Storage.write(["session_diff", input.sessionID], diffs)
      Bus.publish(Session.Event.Diff, {
        sessionID: input.sessionID,
        diff: diffs,
      })
      return Session.update(input.sessionID, (draft) => {
        draft.revert = revert
        draft.summary = {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        }
      })
    }
    return session
  }

  export async function unrevert(input: { sessionID: string }) {
    log.info("unreverting", input)
    SessionRunner.assertNotBusy(input.sessionID)
    const session = await Session.get(input.sessionID)
    if (!session.revert) return session
    if (session.revert.snapshot) await Snapshot.restore(session.revert.snapshot, input.sessionID)
    const next = await Session.update(input.sessionID, (draft) => {
      draft.revert = undefined
    })
    return next
  }

  export async function cleanup(session: Session.Info) {
    if (!session.revert) return
    const sessionID = session.id
    let msgs = await Session.messages({ sessionID })
    const messageID = session.revert.messageID
    const [preserve, remove] = splitWhen(msgs, (x) => x.info.id === messageID)
    msgs = preserve
    for (const msg of remove) {
      await Transcript.remove(sessionID, msg.info.id)
      await Bus.publish(Message.Event.Removed, { sessionID: sessionID, messageID: msg.info.id })
    }
    const last = preserve.at(-1)
    if (session.revert.partID && last) {
      const partID = session.revert.partID
      const [preserveParts, removeParts] = splitWhen(last.parts, (x) => x.id === partID)
      last.parts = preserveParts
      for (const part of removeParts) {
        await Transcript.remove(sessionID, last.info.id, part.id)
        await Bus.publish(Message.Event.PartRemoved, {
          sessionID: sessionID,
          messageID: last.info.id,
          partID: part.id,
        })
      }
    }
    await Session.update(sessionID, (draft) => {
      draft.revert = undefined
    })
  }
}
