import { describe, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Bus } from "../../infra/bus"
import { GlobalBus } from "../../infra/bus/global"
import { Instance } from "../../infra/project/instance"
import { LoopStatus } from "../loop/status"

async function withInstance<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "merakcode-status-test-"))
  return Instance.provide({ directory: dir, fn })
}

describe("LoopStatus.set idle idempotency", () => {
  test("a preparing request holds busy across another loop's idle and synchronous report completion", async () => {
    await withInstance(() => {
      const events: string[] = []
      Bus.subscribe(LoopStatus.Event.Status, (event) => events.push(event.properties.status.type))
      const release = LoopStatus.hold("s1")
      LoopStatus.set("s1", { type: "busy" })
      LoopStatus.set("s1", { type: "idle" })
      LoopStatus.finishSync("s1")
      expect(events).toEqual(["busy"])
      expect(LoopStatus.get("s1").type).toBe("busy")
      release()
      LoopStatus.set("s1", { type: "idle" })
      expect(events).toEqual(["busy", "idle"])
    })
  })

  test("a synchronous idle subscriber can start a request without old completion deleting its busy state", async () => {
    await withInstance(() => {
      let release = () => {}
      const idle: string[] = []
      const wildcard: string[] = []
      const global: string[] = []
      const observeGlobal = (event: {
        payload: { type: string; properties: { sessionID?: string; status?: { type: string } } }
      }) => {
        if (event.payload.type === LoopStatus.Event.Status.type && event.payload.properties.sessionID === "s1")
          global.push(event.payload.properties.status!.type)
      }
      GlobalBus.on("event", observeGlobal)
      Bus.subscribe(LoopStatus.Event.Idle, (event) => idle.push(event.properties.sessionID))
      Bus.subscribe(LoopStatus.Event.Status, (event) => {
        if (event.properties.status.type !== "idle") return
        release = LoopStatus.hold("s1")
        LoopStatus.set("s1", { type: "busy" })
      })
      Bus.subscribeAll((event) => {
        if (event.type === LoopStatus.Event.Status.type) wildcard.push(event.properties.status.type)
      })
      try {
        LoopStatus.set("s1", { type: "busy" })
        LoopStatus.set("s1", { type: "idle" })
        expect(LoopStatus.get("s1").type).toBe("busy")
        expect(idle).toEqual([])
        expect(wildcard).toEqual(["busy", "idle", "busy"])
        expect(global).toEqual(["busy", "idle", "busy"])
      } finally {
        release()
        GlobalBus.off("event", observeGlobal)
      }
    })
  })
  test("busy to idle publishes status and idle; repeated idle publishes nothing", async () => {
    await withInstance(() => {
      const statusEvents: string[] = []
      const idleEvents: string[] = []
      Bus.subscribe(LoopStatus.Event.Status, (e) => statusEvents.push(e.properties.status.type))
      Bus.subscribe(LoopStatus.Event.Idle, (e) => idleEvents.push(e.properties.sessionID))

      LoopStatus.set("s1", { type: "busy" })
      LoopStatus.set("s1", { type: "idle" })
      LoopStatus.set("s1", { type: "idle" })
      LoopStatus.set("s1", { type: "idle" })

      expect(statusEvents).toEqual(["busy", "idle"])
      expect(idleEvents).toEqual(["s1"])
      expect(LoopStatus.get("s1")).toEqual({ type: "idle" })
    })
  })

  test("cancel-style idle on a never-busy session publishes neither status nor idle", async () => {
    await withInstance(() => {
      const statusEvents: string[] = []
      const idleEvents: string[] = []
      Bus.subscribe(LoopStatus.Event.Status, (e) => statusEvents.push(e.properties.status.type))
      Bus.subscribe(LoopStatus.Event.Idle, (e) => idleEvents.push(e.properties.sessionID))

      // Undo/restore calls cancel, i.e. set(idle), on an already idle session.
      LoopStatus.set("s1", { type: "idle" })
      LoopStatus.set("s1", { type: "idle" })

      expect(statusEvents).toEqual([])
      expect(idleEvents).toEqual([])
    })
  })

  test("finishSync on a never-busy session publishes session.status idle but not session.idle", async () => {
    await withInstance(() => {
      const statusEvents: string[] = []
      const idleEvents: string[] = []
      Bus.subscribe(LoopStatus.Event.Status, (e) => statusEvents.push(e.properties.status.type))
      Bus.subscribe(LoopStatus.Event.Idle, (e) => idleEvents.push(e.properties.sessionID))

      LoopStatus.finishSync("s1")

      expect(statusEvents).toEqual(["idle"])
      expect(idleEvents).toEqual([])
      expect(LoopStatus.get("s1")).toEqual({ type: "idle" })
    })
  })

  test("finishSync after busy behaves like set(idle) and publishes session.idle once", async () => {
    await withInstance(() => {
      const statusEvents: string[] = []
      const idleEvents: string[] = []
      Bus.subscribe(LoopStatus.Event.Status, (e) => statusEvents.push(e.properties.status.type))
      Bus.subscribe(LoopStatus.Event.Idle, (e) => idleEvents.push(e.properties.sessionID))

      LoopStatus.set("s1", { type: "busy" })
      LoopStatus.finishSync("s1")
      LoopStatus.finishSync("s1")

      expect(statusEvents).toEqual(["busy", "idle", "idle"])
      expect(idleEvents).toEqual(["s1"])
    })
  })

  test("retry to idle publishes idle once", async () => {
    await withInstance(() => {
      const idleEvents: string[] = []
      Bus.subscribe(LoopStatus.Event.Idle, (e) => idleEvents.push(e.properties.sessionID))

      LoopStatus.set("s1", {
        type: "retry",
        attempt: 1,
        message: "retry",
        next: Date.now() + 1000,
      })
      LoopStatus.set("s1", { type: "idle" })
      LoopStatus.set("s1", { type: "idle" })

      expect(idleEvents).toEqual(["s1"])
    })
  })
})
