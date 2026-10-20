import { expect, test } from "vitest"
import { parseWindowsEvents } from "./windows"

test("Windows events need product process, PID and time correlation; raw fields are excluded", () => {
  const row = {
    pid: 7,
    application: "merak-bin.exe",
    timestamp: "2026-01-02T00:00:00Z",
    module: "Overlay.dll",
    exception_code: "c0000005",
    Message: "secret",
    path: "private",
  }
  const runs = [{ pid: 7, started_at: "2026-01-01T00:00:00Z", run_id: "old" }]
  expect(parseWindowsEvents(JSON.stringify([row]), runs)).toHaveLength(1)
  expect(parseWindowsEvents(JSON.stringify([{ ...row, application: "merakcode.exe" }]), runs)).toHaveLength(1)
  expect(parseWindowsEvents(JSON.stringify([{ ...row, application: "merak.exe" }]), runs)).toHaveLength(1)
  expect(JSON.stringify(parseWindowsEvents(JSON.stringify([row]), runs))).not.toContain("secret")
  expect(parseWindowsEvents(JSON.stringify([{ ...row, application: "other.exe" }]), runs)).toHaveLength(0)
  expect(parseWindowsEvents(JSON.stringify([{ ...row, timestamp: "2025-01-01" }]), runs)).toHaveLength(0)
  expect(parseWindowsEvents(JSON.stringify([{ ...row, pid: 8 }]), runs)).toHaveLength(0)
  expect(parseWindowsEvents("broken", runs)).toHaveLength(0)
})
