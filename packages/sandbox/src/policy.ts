import { realpathSync } from "node:fs"
import path from "node:path"
import { Domain } from "./domain"

/**
 * What a sandboxed command may do. Plain data so it can be written to a file for the helper processes; every path
 * is absolute and resolved to its real location (on macOS /tmp is really /private/tmp).
 */
export type Policy = {
  /** Directories the command cannot read */
  read: { deny: string[] }
  /**
   * The only directories it can write; `protect` stays read-only inside them: .git/hooks, .git/config and MerakCode's
   * config files, which would otherwise run code or loosen permissions outside the sandbox later
   */
  write: { allow: string[]; protect: string[] }
  /**
   * Host patterns (see Domain) allowed or denied without asking; loopback ports in `blockPorts` (the engine's own)
   * are never reachable; `localPorts` are extra loopback ports a non-HTTP connection may use on Linux
   */
  network: { allow: string[]; deny: string[]; blockPorts: number[]; localPorts: number[] }
}

export namespace Policy {
  /** Credential directories under the home folder */
  export const SENSITIVE_HOME_DIRS = [
    ".ssh",
    ".aws",
    ".azure",
    ".kube",
    ".gnupg",
    ".docker",
    ".config/gcloud",
    ".config/gh",
  ]

  /** Paths in each workspace root that commands may not change */
  export const PROTECTED = [
    ".git/hooks",
    ".git/config",
    "merakcode.json",
    "merakcode.jsonc",
    ".merakcode/merakcode.json",
    ".merakcode/merakcode.jsonc",
  ]

  /** Package manager caches under the home folder: installing dependencies writes there, and they hold no secrets */
  export const CACHE_DIRS = [
    ".npm",
    ".cache",
    ".pnpm-store",
    ".local/share/pnpm",
    ".yarn",
    ".bun/install/cache",
    ".cargo/registry",
    ".cargo/git",
    "go/pkg/mod",
    ".m2/repository",
    ".gradle/caches",
    "Library/Caches",
    "AppData/Local/npm-cache",
    "AppData/Local/pnpm",
  ]

  function real(file: string) {
    try {
      return realpathSync.native(file)
    } catch {
      return path.resolve(file)
    }
  }

  const unique = (items: string[]) => [...new Set(items)]

  export function build(input: {
    workspace: string[]
    home: string
    tmp: string
    /** Extra writable directories: approved during a session, or from the config */
    writable?: string[]
    /** Extra unreadable directories; `~/x` means x under the home folder */
    readDeny?: string[]
    network?: Partial<Policy["network"]>
  }): Policy {
    const home = (dir: string) => (dir === "~" || dir.startsWith("~/") ? path.join(input.home, dir.slice(2)) : dir)
    const workspace = input.workspace.map(real)
    return {
      read: {
        deny: unique(
          [...SENSITIVE_HOME_DIRS.map((dir) => path.join(input.home, dir)), ...(input.readDeny ?? []).map(home)].map(
            real,
          ),
        ),
      },
      write: {
        allow: unique(
          [
            ...workspace,
            input.tmp,
            ...CACHE_DIRS.map((dir) => path.join(input.home, dir)),
            ...(input.writable ?? []),
          ].map(real),
        ),
        protect: workspace.flatMap((root) => PROTECTED.map((file) => path.join(root, ...file.split("/")))),
      },
      network: {
        allow: unique((input.network?.allow ?? []).filter(Domain.valid)),
        deny: unique((input.network?.deny ?? []).filter(Domain.valid)),
        blockPorts: unique((input.network?.blockPorts ?? []).map(String)).map(Number),
        localPorts: unique((input.network?.localPorts ?? []).map(String)).map(Number),
      },
    }
  }
}
