/**
 * Linux Landlock (kernel 5.13+): constants and the structs passed to its system calls.
 * See https://docs.kernel.org/userspace-api/landlock.html
 */
export namespace Landlock {
  /** System call numbers; the same on x86_64 and aarch64 */
  export const SYS = { createRuleset: 444, addRule: 445, restrictSelf: 446 }
  /** prctl differs by architecture */
  export const PRCTL = { x64: 157, arm64: 167 }
  export const PR_SET_NO_NEW_PRIVS = 38
  export const O_PATH = 0o10000000
  /** Flag for create_ruleset(NULL, 0, flag): returns the ABI version instead of a ruleset */
  export const CREATE_RULESET_VERSION = 1
  export const RULE = { PATH_BENEATH: 1, NET_PORT: 2 }

  export const FS = {
    EXECUTE: 1 << 0,
    WRITE_FILE: 1 << 1,
    READ_FILE: 1 << 2,
    READ_DIR: 1 << 3,
    REMOVE_DIR: 1 << 4,
    REMOVE_FILE: 1 << 5,
    MAKE_CHAR: 1 << 6,
    MAKE_DIR: 1 << 7,
    MAKE_REG: 1 << 8,
    MAKE_SOCK: 1 << 9,
    MAKE_FIFO: 1 << 10,
    MAKE_BLOCK: 1 << 11,
    MAKE_SYM: 1 << 12,
    /** ABI 2 */
    REFER: 1 << 13,
    /** ABI 3 */
    TRUNCATE: 1 << 14,
  }
  /** ABI 4 (kernel 6.7) */
  export const NET = { BIND_TCP: 1 << 0, CONNECT_TCP: 1 << 1 }

  /** File rights this ABI knows; IOCTL_DEV (ABI 5) is left alone so terminals keep working */
  export function handled(abi: number) {
    return 0x1fff | (abi >= 2 ? FS.REFER : 0) | (abi >= 3 ? FS.TRUNCATE : 0)
  }

  export function read(dir: boolean) {
    return FS.EXECUTE | FS.READ_FILE | (dir ? FS.READ_DIR : 0)
  }

  /** Directory rights would make adding a rule for a regular file fail with EINVAL */
  export function write(abi: number, dir: boolean) {
    if (dir) return handled(abi)
    return FS.EXECUTE | FS.WRITE_FILE | FS.READ_FILE | (abi >= 3 ? FS.TRUNCATE : 0)
  }

  export function rulesetAttr(abi: number, fs: number, net: number) {
    const buffer = Buffer.alloc(abi >= 4 ? 16 : 8)
    buffer.writeBigUInt64LE(BigInt(fs), 0)
    if (abi >= 4) buffer.writeBigUInt64LE(BigInt(net), 8)
    return buffer
  }

  export function pathBeneath(access: number, fd: number) {
    const buffer = Buffer.alloc(12)
    buffer.writeBigUInt64LE(BigInt(access), 0)
    buffer.writeInt32LE(fd, 8)
    return buffer
  }

  export function netPort(access: number, port: number) {
    const buffer = Buffer.alloc(16)
    buffer.writeBigUInt64LE(BigInt(access), 0)
    buffer.writeBigUInt64LE(BigInt(port), 8)
    return buffer
  }
}
