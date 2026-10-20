/**
 * Linux sandbox helper, started as `node sandbox-linux.js <request file>`. It restricts itself with Landlock and
 * then replaces itself with the shell (execve keeps the restriction), so the command and everything it starts
 * inherit the same limits. The request file is private (0600) and deleted as soon as it is read.
 */
import { closeSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs"
import { native } from "@merakcode/util/ffi"
import { Landlock } from "./landlock"
import { readRoots } from "./read-roots"

export type Request = {
  shell: string
  command: string
  env: Record<string, string>
  readDeny: string[]
  write: string[]
  /** Loopback ports TCP may connect to: the proxy and the configured local ports */
  ports: number[]
}

/** Writable devices every shell expects */
const DEVICES = ["/dev/null", "/dev/zero", "/dev/full", "/dev/tty", "/dev/pts", "/dev/shm"]

function fail(message: string): never {
  process.stderr.write(`[MRK-5003] sandbox: ${message}\n`)
  process.exit(125)
}

const file = process.argv[2]
if (!file) fail("missing request file")
const request = JSON.parse(readFileSync(file, "utf8")) as Request
unlinkSync(file)

const ffi = native() ?? fail("node:ffi is not available")
const ARGS = ["int64", "int64", "int64", "int64", "int64", "int64"]
const syscall = (...args: (bigint | number)[]) => {
  const values = [...args.map(BigInt), 0n, 0n, 0n, 0n, 0n, 0n].slice(0, 6)
  return Number(ffi.call("libc.so.6", "syscall", ARGS, "int64", values))
}
const errno = () => ffi.read(BigInt(ffi.call("libc.so.6", "__errno_location", [], "ptr", [])), 4).readInt32LE(0)
const check = (result: number, what: string) => {
  if (result < 0) fail(`${what} failed (errno ${errno()})`)
  return result
}

const abi = syscall(Landlock.SYS.createRuleset, 0, 0, Landlock.CREATE_RULESET_VERSION)
if (abi < 1) fail(`Landlock is not available (errno ${errno()}); it needs Linux 5.13 or newer with Landlock enabled`)
const fs = Landlock.handled(abi)
const attr = Landlock.rulesetAttr(abi, fs, abi >= 4 ? Landlock.NET.CONNECT_TCP : 0)
const ruleset = check(syscall(Landlock.SYS.createRuleset, ffi.pointer(attr), attr.length, 0), "landlock_create_ruleset")

function allow(target: string, rights: (dir: boolean) => number) {
  const stat = statSync(target, { throwIfNoEntry: false })
  if (!stat) return
  const fd = (() => {
    try {
      return openSync(target, Landlock.O_PATH)
    } catch {
      return undefined
    }
  })()
  if (fd === undefined) return
  const rule = Landlock.pathBeneath(rights(stat.isDirectory()) & fs, fd)
  const result = syscall(Landlock.SYS.addRule, ruleset, Landlock.RULE.PATH_BENEATH, ffi.pointer(rule), 0)
  closeSync(fd)
  check(result, `landlock_add_rule ${target}`)
}

for (const target of readRoots(request.readDeny)) allow(target, Landlock.read)
for (const target of [...request.write, ...DEVICES]) allow(target, (dir) => Landlock.write(abi, dir))
if (abi >= 4)
  for (const port of request.ports) {
    const rule = Landlock.netPort(Landlock.NET.CONNECT_TCP, port)
    check(
      syscall(Landlock.SYS.addRule, ruleset, Landlock.RULE.NET_PORT, ffi.pointer(rule), 0),
      `landlock_add_rule port ${port}`,
    )
  }

check(
  syscall(
    process.arch === "arm64" ? Landlock.PRCTL.arm64 : Landlock.PRCTL.x64,
    Landlock.PR_SET_NO_NEW_PRIVS,
    1,
    0,
    0,
    0,
  ),
  "prctl",
)
check(syscall(Landlock.SYS.restrictSelf, ruleset, 0), "landlock_restrict_self")
closeSync(ruleset)
process.execve!(request.shell, [request.shell, "-c", request.command], request.env)
