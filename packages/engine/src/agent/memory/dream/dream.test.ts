import { describe, expect, test } from "vitest"
import { AutoDream } from "./dream"

const MIN_HOURS = 24
const MIN_SESSIONS = 5
const H = 3_600_000

describe("AutoDream gates (pure functions)", () => {
  describe("timeGatePassed", () => {
    test("blocks when less than minHours have passed since the last consolidation", () => {
      const now = 1_700_000_000_000
      expect(AutoDream.timeGatePassed(now, now, MIN_HOURS)).toBe(false)
      expect(AutoDream.timeGatePassed(now, now - 1 * H, MIN_HOURS)).toBe(false)
      expect(AutoDream.timeGatePassed(now, now - 23 * H, MIN_HOURS)).toBe(false)
    })

    test("passes when more than minHours have passed", () => {
      const now = 1_700_000_000_000
      expect(AutoDream.timeGatePassed(now, now - 25 * H, MIN_HOURS)).toBe(true)
      expect(AutoDream.timeGatePassed(now, 0, MIN_HOURS)).toBe(true) // no previous lock
    })

    test("passes at exactly minHours (>=)", () => {
      const now = 1_700_000_000_000
      expect(AutoDream.timeGatePassed(now, now - 24 * H, MIN_HOURS)).toBe(true)
    })
  })

  describe("sessionGatePassed", () => {
    test("passes when the session count reaches the threshold", () => {
      expect(AutoDream.sessionGatePassed(MIN_SESSIONS, MIN_SESSIONS)).toBe(true)
      expect(AutoDream.sessionGatePassed(MIN_SESSIONS + 3, MIN_SESSIONS)).toBe(true)
    })

    test("blocks when there are too few sessions", () => {
      expect(AutoDream.sessionGatePassed(MIN_SESSIONS - 1, MIN_SESSIONS)).toBe(false)
      expect(AutoDream.sessionGatePassed(0, MIN_SESSIONS)).toBe(false)
    })
  })

  describe("lockAvailable", () => {
    test("passes when the lock is free (priorMtime returned)", () => {
      expect(AutoDream.lockAvailable(0)).toBe(true)
      expect(AutoDream.lockAvailable(1_700_000_000_000)).toBe(true)
    })

    test("blocks when the lock is held (null returned)", () => {
      expect(AutoDream.lockAvailable(null)).toBe(false)
    })
  })

  describe("combined gates (all must pass)", () => {
    test("consolidates when the time, session and lock gates all pass", () => {
      const now = 1_700_000_000_000
      const time = AutoDream.timeGatePassed(now, 0, MIN_HOURS)
      const sessions = AutoDream.sessionGatePassed(7, MIN_SESSIONS)
      const lock = AutoDream.lockAvailable(0)
      expect(time && sessions && lock).toBe(true)
    })

    test("does not consolidate when any gate fails", () => {
      const now = 1_700_000_000_000
      // not enough time
      expect(AutoDream.timeGatePassed(now, now, MIN_HOURS) ? false : true).toBe(true)
      // not enough sessions
      expect(AutoDream.sessionGatePassed(2, MIN_SESSIONS) ? false : true).toBe(true)
      // lock held
      expect(AutoDream.lockAvailable(null) ? false : true).toBe(true)
    })
  })
})
