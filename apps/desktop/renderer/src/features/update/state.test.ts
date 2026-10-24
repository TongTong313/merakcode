import { describe, expect, test } from "vitest"
import { reduce, type UpdateState } from "./state"

const idle: UpdateState = { kind: "idle" }

describe("update state", () => {
  test("checking, then already up to date", () => {
    const checking = reduce(idle, { type: "checking" })
    expect(checking).toEqual({ kind: "checking" })
    expect(reduce(checking, { type: "latest" })).toEqual({ kind: "latest" })
  })

  test("a new version, downloading with progress, then ready to install", () => {
    const available = reduce({ kind: "checking" }, { type: "available", version: "0.2.0" })
    expect(available).toEqual({ kind: "available", version: "0.2.0" })
    const downloading = reduce(available, { type: "progress", percent: 41.6 })
    expect(downloading).toEqual({ kind: "downloading", version: "0.2.0", percent: 42 })
    expect(reduce(downloading, { type: "progress", percent: 90 })).toEqual({
      kind: "downloading",
      version: "0.2.0",
      percent: 90,
    })
    expect(reduce(downloading, { type: "downloaded", version: "0.2.0" })).toEqual({ kind: "ready", version: "0.2.0" })
  })

  test("an install that cannot update itself gets the download page", () => {
    expect(reduce({ kind: "checking" }, { type: "manual", version: "0.2.0", reason: "mac-unsigned" })).toEqual({
      kind: "manual",
      version: "0.2.0",
      reason: "mac-unsigned",
    })
  })

  test("a periodic check does not hide a download in progress or a finished one", () => {
    expect(reduce({ kind: "downloading", version: "0.2.0", percent: 10 }, { type: "checking" })).toEqual({
      kind: "downloading",
      version: "0.2.0",
      percent: 10,
    })
    expect(reduce({ kind: "ready", version: "0.2.0" }, { type: "checking" })).toEqual({
      kind: "ready",
      version: "0.2.0",
    })
    expect(reduce({ kind: "ready", version: "0.2.0" }, { type: "available", version: "0.2.0" })).toEqual({
      kind: "ready",
      version: "0.2.0",
    })
  })

  test("an error keeps its code and remembers which version it was about", () => {
    expect(
      reduce(
        { kind: "downloading", version: "0.2.0", percent: 50 },
        { type: "error", code: "MRK-8002", message: "socket hang up" },
      ),
    ).toEqual({
      kind: "error",
      code: "MRK-8002",
      message: "socket hang up",
      version: "0.2.0",
    })
    expect(reduce({ kind: "checking" }, { type: "error", code: "MRK-8001", message: "offline" })).toEqual({
      kind: "error",
      code: "MRK-8001",
      message: "offline",
    })
  })

  test("an explicit opt-out reports that updates are turned off", () => {
    expect(reduce(idle, { type: "unavailable", reason: "disabled" })).toEqual({
      kind: "unavailable",
      reason: "disabled",
    })
    expect(reduce({ kind: "ready", version: "0.2.0" }, { type: "unavailable", reason: "disabled" })).toEqual({
      kind: "ready",
      version: "0.2.0",
    })
  })

  test("checking again after an error starts over", () => {
    expect(reduce({ kind: "error", code: "MRK-8001", message: "offline" }, { type: "checking" })).toEqual({
      kind: "checking",
    })
  })
})
