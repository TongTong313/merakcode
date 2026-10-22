import { afterEach, describe, expect, test } from "vitest"
import { authorizeLocalRequest } from "./local-guard"
import { runWithPeer } from "./peer-context"
import { setPeerPidLookupForTest } from "./peer-pid"

const secret = "guard-secret"
const username = "merakcode"
const basic = (password = secret) => new Headers({ authorization: `Basic ${btoa(`${username}:${password}`)}` })

/** The peer on port 60000 is pid 22, whose parent is the desktop main process 11; other peers are outside the tree */
function desktopTree() {
  setPeerPidLookupForTest({
    async owners() {
      return [
        { localAddr: "127.0.0.1", localPort: 4096, remoteAddr: "127.0.0.1", remotePort: 60000, pid: 22 },
        { localAddr: "127.0.0.1", localPort: 4096, remoteAddr: "127.0.0.1", remotePort: 60001, pid: 99 },
      ]
    },
    async parentPid(pid) {
      if (pid === 22) return 11
      return 1
    },
  })
}

/** Sends a request from the given peer port; the desktop main process pid is 11 */
const fromPort = (port: number, method: string, path: string, headers = basic()) =>
  runWithPeer({ address: "127.0.0.1", port }, () =>
    authorizeLocalRequest({ method, path, headers, secret, username, parentPid: 11, listenPort: 4096 }),
  )

afterEach(() => setPeerPidLookupForTest(undefined))

describe("authorizeLocalRequest", () => {
  test("rejects missing credentials or a wrong password as unauthorized", async () => {
    const input = { method: "GET", path: "/global/health", secret, username }
    expect(await authorizeLocalRequest({ ...input, headers: new Headers() })).toBe("unauthorized")
    expect(await authorizeLocalRequest({ ...input, headers: basic("wrong") })).toBe("unauthorized")
  })

  test("allows a correct password when no desktop main process is set", async () => {
    expect(await authorizeLocalRequest({ method: "POST", path: "/pty", headers: basic(), secret, username })).toBe("ok")
  })

  test("with a desktop main process set, ordinary requests skip the process tree check", async () => {
    desktopTree()
    expect(await fromPort(60001, "POST", "/session/abc/message")).toBe("ok")
    expect(await fromPort(60001, "GET", "/provider")).toBe("ok")
    expect(await fromPort(60001, "GET", "/config")).toBe("ok")
  })

  // A stolen password must not let another process open a terminal, install MCP servers or change config/credentials
  test("with a desktop main process set, risky endpoints accept only requests from its process tree", async () => {
    desktopTree()
    const risky: [string, string][] = [
      ["POST", "/pty"],
      ["GET", "/pty/term-1/connect"],
      ["GET", "/bash/jobs"],
      ["POST", "/mcp"],
      ["POST", "/mcp-management/install"],
      ["PUT", "/auth/deepseek"],
      ["PATCH", "/global/config"],
      ["PATCH", "/config"],
      ["PUT", "/provider/openai"],
      ["POST", "/sandbox/install"],
      ["POST", "/sandbox/reset"],
    ]
    for (const [method, path] of risky) {
      expect(await fromPort(60000, method, path)).toBe("ok")
      expect(await fromPort(60001, method, path)).toBe("forbidden")
    }
  })

  // A command the agent runs is a child of the engine: even with the password it must not approve its own
  // permission requests, answer questions, or open an unsandboxed terminal
  test("requests from the engine's own child processes cannot use guarded endpoints", async () => {
    setPeerPidLookupForTest({
      async owners() {
        return [
          { localAddr: "127.0.0.1", localPort: 4096, remoteAddr: "127.0.0.1", remotePort: 60000, pid: 22 },
          { localAddr: "127.0.0.1", localPort: 4096, remoteAddr: "127.0.0.1", remotePort: 60002, pid: 77 },
        ]
      },
      async parentPid(pid) {
        if (pid === 22) return 11
        if (pid === 77) return 50
        if (pid === 50) return 11
        return 1
      },
    })
    const from = (port: number, method: string, path: string) =>
      runWithPeer({ address: "127.0.0.1", port }, () =>
        authorizeLocalRequest({ method, path, headers: basic(), secret, username, engine: 50, listenPort: 4096 }),
      )
    expect(await from(60002, "POST", "/permission/req-1/reply")).toBe("forbidden")
    expect(await from(60002, "POST", "/question/q-1/reply")).toBe("forbidden")
    expect(await from(60002, "POST", "/pty")).toBe("forbidden")
    expect(await from(60002, "GET", "/permission")).toBe("ok")
    expect(await from(60002, "POST", "/session/abc/message")).toBe("ok")
    expect(await from(60000, "POST", "/permission/req-1/reply")).toBe("ok")
  })

  // The desktop window's first config read was refused at startup: the connection or the process was not visible to
  // the lookup yet, and the window stayed on its splash screen
  test("a peer the lookup misses at first is looked up again before a risky request is refused", async () => {
    let calls = 0
    setPeerPidLookupForTest({
      async owners() {
        calls++
        if (calls <= 2) return []
        return [{ localAddr: "127.0.0.1", localPort: 4096, remoteAddr: "127.0.0.1", remotePort: 60000, pid: 22 }]
      },
      async parentPid(pid) {
        return pid === 22 ? 11 : 1
      },
    })
    expect(await fromPort(60000, "GET", "/global/config")).toBe("ok")
  })

  test("a parent the lookup does not know yet is looked up again", async () => {
    let calls = 0
    setPeerPidLookupForTest({
      async owners() {
        return [{ localAddr: "127.0.0.1", localPort: 4096, remoteAddr: "127.0.0.1", remotePort: 60000, pid: 22 }]
      },
      async parentPid(pid) {
        calls++
        if (pid === 22 && calls > 1) return 11
        return undefined
      },
    })
    expect(await fromPort(60000, "GET", "/global/config")).toBe("ok")
  })

  test("denies without throwing when the parent process lookup fails", async () => {
    setPeerPidLookupForTest({
      async owners() {
        return [{ localAddr: "127.0.0.1", localPort: 4096, remoteAddr: "127.0.0.1", remotePort: 60000, pid: 22 }]
      },
      async parentPid() {
        throw new Error('Executable not found in $PATH: "wmic"')
      },
    })
    expect(await fromPort(60000, "POST", "/pty")).toBe("forbidden")
  })
})
