import { expect, test } from "vitest"
import type { Event, GlobalEvent } from "@merakcode/sdk/client"
import { isForeignDirectory, resetForeignEventReports, wrapGlobalEvent } from "../../src/cli/cmd/tui/context/event"

/**
 * Guards cross-directory event delivery. Events carry the Instance directory of their session, which can differ from
 * the TUI's launch directory (`Session.create` uses the working directory at creation time). Dropping events whose
 * `globalEvent.directory` differs from `project.directory()` loses that session's message.updated /
 * message.part.updated: messages never appear and state does not roll back after ESC. Such events must reach the
 * handler.
 */

const LAUNCHED = "C:\\Users\\me\\code\\alibaba-cn\\merakcode"
const SESSION_DIR = "C:\\Users\\me\\code\\alibaba-cn\\merakcode\\dist\\merakcode-v1.3.6-offline\\win"

function globalEvent(directory: string, type = "message.part.updated"): GlobalEvent {
  return {
    directory,
    workspace: undefined,
    payload: { type, properties: { sessionID: "ses_foreign" } },
  } as unknown as GlobalEvent
}

test("events reach the handler when the session directory differs from the launch directory", () => {
  resetForeignEventReports()
  const received: Event[] = []
  const dispatch = wrapGlobalEvent(
    (event) => received.push(event),
    () => LAUNCHED,
  )

  dispatch(globalEvent(SESSION_DIR))
  dispatch(globalEvent(SESSION_DIR, "message.updated"))
  dispatch(globalEvent(LAUNCHED))

  // All three must arrive: the directory does not decide delivery, the handler routes events by sessionID.
  expect(received.map((event) => event.type)).toEqual([
    "message.part.updated",
    "message.updated",
    "message.part.updated",
  ])
  expect(received.map((event) => (event.properties as { sessionID: string }).sessionID)).toEqual([
    "ses_foreign",
    "ses_foreign",
    "ses_foreign",
  ])
})

test("events from the global directory are delivered too", () => {
  resetForeignEventReports()
  const received: Event[] = []
  const dispatch = wrapGlobalEvent(
    (event) => received.push(event),
    () => LAUNCHED,
  )

  dispatch(globalEvent("global", "server.connected"))

  expect(received).toHaveLength(1)
})

test("isForeignDirectory is true across directories and false for equivalent spellings of the same one", () => {
  expect(isForeignDirectory(globalEvent(SESSION_DIR), LAUNCHED)).toBe(true)

  expect(isForeignDirectory(globalEvent(LAUNCHED), LAUNCHED)).toBe(false)
  expect(isForeignDirectory(globalEvent(LAUNCHED + "\\"), LAUNCHED)).toBe(false)
  expect(isForeignDirectory(globalEvent(LAUNCHED.replace(/\\/g, "/")), LAUNCHED)).toBe(false)
  expect(isForeignDirectory(globalEvent(LAUNCHED.toUpperCase()), LAUNCHED)).toBe(false)
  expect(isForeignDirectory(globalEvent("  " + LAUNCHED + "  "), LAUNCHED)).toBe(false)
  expect(isForeignDirectory(globalEvent("global"), LAUNCHED)).toBe(false)
  expect(isForeignDirectory(globalEvent(""), LAUNCHED)).toBe(false)
})
