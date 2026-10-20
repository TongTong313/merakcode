import { describe, expect, test } from "vitest"
import {
  isPidInTree,
  parseLsof,
  parseNetstat,
  parsePidEqParentLines,
  parseWmicValueParents,
  pidFromTcpOwners,
  readWindowsParentMapFromToolhelp,
  setPeerPidLookupForTest,
} from "./peer-pid"

describe("parseNetstat", () => {
  test("parses established loopback rows", () => {
    const rows = parseNetstat(`
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:4096         127.0.0.1:60001        ESTABLISHED     4321
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       900
`)
    expect(rows).toEqual([
      { localAddr: "127.0.0.1", localPort: 4096, remoteAddr: "127.0.0.1", remotePort: 60001, pid: 4321 },
    ])
  })
})

describe("pidFromTcpOwners", () => {
  test("prefers the client-side loopback row so Electron not the engine is bound", () => {
    const owners = [
      { localAddr: "127.0.0.1", localPort: 4096, remoteAddr: "127.0.0.1", remotePort: 54343, pid: 12916 },
      { localAddr: "127.0.0.1", localPort: 54343, remoteAddr: "127.0.0.1", remotePort: 4096, pid: 3740 },
    ]
    expect(pidFromTcpOwners(owners, { localPort: 4096, remoteAddr: "127.0.0.1", remotePort: 54343 })).toBe(3740)
  })
})

describe("parseLsof", () => {
  test("parses macOS ESTABLISHED rows even when state is the last column", () => {
    // Real darwin output of lsof -nP -iTCP -sTCP:ESTABLISHED: NAME is followed by (ESTABLISHED)
    const rows = parseLsof(`COMMAND   PID    USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
Electron  34700 jordan   26u  IPv4 0xabc      0t0  TCP 127.0.0.1:56299->127.0.0.1:4096 (ESTABLISHED)
bun       34720 jordan   19u  IPv4 0xdef      0t0  TCP 127.0.0.1:4096->127.0.0.1:56299 (ESTABLISHED)
`)
    expect(rows).toEqual([
      { localAddr: "127.0.0.1", localPort: 56299, remoteAddr: "127.0.0.1", remotePort: 4096, pid: 34700 },
      { localAddr: "127.0.0.1", localPort: 4096, remoteAddr: "127.0.0.1", remotePort: 56299, pid: 34720 },
    ])
    expect(pidFromTcpOwners(rows, { localPort: 4096, remoteAddr: "127.0.0.1", remotePort: 56299 })).toBe(34700)
  })
})

describe("windows parent map parsers", () => {
  test("parses WMIC /VALUE records regardless of field order", () => {
    const map = parseWmicValueParents(`
ParentProcessId=4
ProcessId=100


ProcessId=200
ParentProcessId=100
`)
    expect(map.get(100)).toBe(4)
    expect(map.get(200)).toBe(100)
  })

  test("parses CIM pid=ppid lines", () => {
    const map = parsePidEqParentLines("100=4\r\n200=100\r\nnot-a-row\r\n")
    expect(map.get(100)).toBe(4)
    expect(map.get(200)).toBe(100)
    expect(map.size).toBe(2)
  })
})

describe("isPidInTree", () => {
  test("treats parent lookup errors as not in tree instead of throwing", async () => {
    setPeerPidLookupForTest({
      async owners() {
        return []
      },
      async parentPid() {
        throw new Error('Executable not found in $PATH: "wmic"')
      },
    })
    expect(await isPidInTree(22, 11)).toBe(false)
    setPeerPidLookupForTest(undefined)
  })

  test.skipIf(process.platform !== "win32")(
    "windows process tree lookup finds the current parent without wmic on PATH",
    async () => {
      setPeerPidLookupForTest(undefined)
      expect(process.ppid).toBeGreaterThan(0)
      expect(await isPidInTree(process.pid, process.ppid)).toBe(true)
    },
    5_000,
  )
})

describe("readWindowsParentMapFromToolhelp", () => {
  test.skipIf(process.platform !== "win32")(
    "maps the current process to its parent without spawning powershell",
    () => {
      const map = readWindowsParentMapFromToolhelp()
      expect(map.size).toBeGreaterThan(0)
      expect(map.get(process.pid)).toBe(process.ppid)
    },
  )
})
