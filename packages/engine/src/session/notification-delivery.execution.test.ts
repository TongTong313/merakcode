import { describe, expect, test, vi } from "vitest"
import { Instance } from "../project/instance"
import { Session } from "."
import { SessionExecution } from "./execution"
import { SessionNotification } from "./notification"
import { SessionNotificationDelivery } from "./notification-delivery"
import { SessionRunner } from "./runner"
import { tmpdir } from "../../test/fixture/fixture"
import { setTimeout as pause } from "node:timers/promises"

describe("notification delivery execution boundary", () => {
  for (const cancelled of [false, true]) {
    test(`dispatches independently after the originating request is ${cancelled ? "cancelled" : "finished"}`, async () => {
      await using directory = await tmpdir()
      await Instance.provide({
        directory: directory.path,
        fn: async () => {
          const session = await Session.create({ title: "notification execution boundary" })
          const scope = SessionExecution.create({ id: `notification-${session.id}`, sessionID: session.id })
          const notification = await SessionNotification.enqueue({
            sessionID: session.id,
            type: "workflow.finished",
            text: "The independent workflow completed.",
          })
          let resolve!: () => void
          const dispatched = new Promise<void>((done) => {
            resolve = done
          })
          const seen: Array<{ sessionID: string; scope: SessionExecution.Scope | undefined; directory: string }> = []
          // Control only the model-loop boundary. Real notification storage,
          // Instance context, subscriptions and timer dispatch run unchanged.
          const execute = async (input: Parameters<typeof SessionRunner.loop>[0]) => {
            seen.push({ sessionID: input.sessionID, scope: SessionExecution.current(), directory: Instance.directory })
            await SessionNotification.ack(input.sessionID, [notification.id])
            resolve()
            return {} as never
          }
          const loop = vi
            .spyOn(SessionRunner, "loop")
            .mockImplementation(Object.assign(execute, { force: execute, schema: SessionRunner.loop.schema }))
          try {
            SessionExecution.run(scope, () => SessionNotificationDelivery.request(session.id, { delay: 20 }))
            if (cancelled) scope.controller.abort(new DOMException("Originating turn cancelled", "AbortError"))
            SessionExecution.finish(scope)
            await Promise.race([
              dispatched,
              pause(2_000).then(() => {
                throw new Error("Notification was not dispatched")
              }),
            ])
            expect(seen).toEqual([{ sessionID: session.id, scope: undefined, directory: directory.path }])
            expect(await SessionNotification.list(session.id)).toEqual([])
          } finally {
            loop.mockRestore()
            SessionExecution.finish(scope)
            await Instance.dispose()
          }
        },
      })
    })
  }
})
