import os from "os"
import path from "path"
import { realpathSync, statSync } from "node:fs"
import { SandboxPolicy } from "./sandbox-policy"
import { Global } from "../../infra/global/index"
import { Instance } from "../../infra/project/instance"
import { PermissionNext } from "./next"
import type { PermissionLevel } from "./level"
import type { Session } from "../session"
import type { Agent } from "../agent"

/** Classifies actual operations and combines the selected root level with explicit and hard agent limits. */
export namespace PermissionPolicy {
  function realTarget(file: string): string {
    const absolute = path.resolve(file)
    try {
      return realpathSync.native(absolute)
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
      const parent = path.dirname(absolute)
      return parent === absolute ? absolute : path.join(realTarget(parent), path.basename(absolute))
    }
  }
  export type Mode = PermissionLevel.Value
  export type Grant = PermissionNext.Grant
  export type Ask = PermissionNext.Check

  /** Permission keys that edit files */
  export const WRITE = ["edit", "protected_write", "config_write", "external_write"]
  /** Hard agent limits: denies whole keys, placed after user rules and grants so no mode can lift them */
  export function deny(...keys: string[]): PermissionNext.Ruleset {
    return keys.map((permission) => ({ permission, pattern: "*", action: "deny" as const }))
  }

  /** Default allowlist, only for downloading dependencies and code; uploads are caught by the risky command rules */
  export const NETWORK_ALLOW = [
    // JavaScript
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "registry.npmmirror.com",
    "cdn.npmmirror.com",
    // Python
    "pypi.org",
    "files.pythonhosted.org",
    "pypi.tuna.tsinghua.edu.cn",
    // Rust
    "crates.io",
    "index.crates.io",
    "static.crates.io",
    "static.rust-lang.org",
    "rsproxy.cn",
    // Go
    "proxy.golang.org",
    "sum.golang.org",
    "goproxy.cn",
    // Java
    "repo.maven.apache.org",
    "repo1.maven.org",
    "maven.aliyun.com",
    "services.gradle.org",
    "plugins.gradle.org",
    // Ruby
    "rubygems.org",
    // Code hosting
    "github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
    "gitlab.com",
    "gitee.com",
    // General mirrors
    "mirrors.aliyun.com",
    "mirrors.tuna.tsinghua.edu.cn",
  ]

  /** Full rule chain: mode defaults + user rules + mode enforcement */
  export function ruleset(mode: Mode, user: PermissionNext.Ruleset = []): PermissionNext.Ruleset {
    if (mode === "ask" || mode === "autoApprove")
      return [
        { permission: "*", pattern: "*", action: "ask" },
        ...(mode === "autoApprove"
          ? [
              "read",
              "glob",
              "grep",
              "ls",
              "skill",
              "edit",
              "bash_readonly",
              "plan_generate",
              "plan_edit",
              "plan_read_chunk",
              "plan_simplify",
            ].map((permission) => ({ permission, pattern: "*", action: "allow" as const }))
          : []),
        ...user.filter((rule) => rule.action === "deny"),
      ]
    return [{ permission: "*", pattern: "*", action: "allow" }]
  }

  export function execution(input: {
    agent: Agent.Info
    session: Session.Info
    permissionLevel?: PermissionLevel.Value
    child?: boolean
    grants?: PermissionNext.Ruleset
  }): PermissionNext.Ruleset {
    const mode = input.permissionLevel ?? input.session.permissionLevel ?? "ask"
    const user = PermissionNext.merge(input.agent.permission, input.grants ?? [], input.session.permission ?? [])
    const child = Boolean(input.session.parentID) || input.child === true
    return PermissionNext.merge(
      PermissionPolicy.ruleset(mode, user),
      input.agent.profile?.restrictedRules ?? [],
      child ? PermissionNext.appendForbidNestedSubagentRule() : [],
    )
  }

  /**
   * Workspace of the current instance (every root and its git root in multi-root setups) and the home directory;
   * file classification and command analysis use them to decide inside vs outside
   */
  export function scope() {
    return {
      workspace: Instance.workspace.folders.flatMap((folder) =>
        folder.worktree === "/" || folder.worktree === folder.path ? [folder.path] : [folder.path, folder.worktree],
      ),
      home: os.homedir(),
    }
  }

  /** Files holding secrets: .env, keys, certificates, cloud and package manager credentials */
  const SENSITIVE_NAMES = [
    /^\.env$/,
    /^\.env\.(?!example$|sample$|template$|dist$).+$/,
    /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/,
    /\.(pem|key|p12|pfx|keystore|jks)$/,
    /^\.(npmrc|pypirc|netrc|git-credentials|pgpass)$/,
    /^credentials(\.json)?$/,
  ]
  /** Credential directories under home: asked about as sensitive files, unreadable inside the sandbox */
  export const SENSITIVE_HOME_DIRS = SandboxPolicy.SENSITIVE_HOME_DIRS

  function inside(root: string, target: string) {
    const relative = path.relative(root, target)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }

  /** Whether a file is named like one holding secrets (.env, id_rsa, *.pem, ...), wherever it is */
  export function sensitiveName(file: string) {
    const name = path.basename(file)
    return SENSITIVE_NAMES.some((pattern) => pattern.test(name))
  }

  export function sensitive(file: string, home: string) {
    if (sensitiveName(file)) return true
    // MerakCode's own store of provider keys
    if (path.resolve(file) === path.resolve(Global.Path.data, "auth.json")) return true
    return SENSITIVE_HOME_DIRS.some((dir) => inside(path.join(home, dir), file))
  }

  /** MerakCode's config files, global or a project's: changing them changes what the agent is allowed to do */
  const CONFIG_NAMES = new Set(["merakcode.json", "merakcode.jsonc"])

  export function config(file: string) {
    return CONFIG_NAMES.has(path.basename(file))
  }

  /**
   * Classifies a file operation. workspace holds the session's workspace roots (several in multi-root setups), path is
   * absolute.
   * - read: read inside the workspace, external_read outside, sensitive_read for sensitive files
   * - write: config_write for MerakCode's config files anywhere, edit inside the workspace, protected_write for .git
   *   and dotfiles inside it, external_write outside
   */
  export function file(input: {
    op: "read" | "write"
    path: string
    workspace: string[]
    home: string
    /** A directory (search root of ls, glob, grep): evaluated and granted for the whole directory */
    directory?: boolean
  }): Ask {
    const logical = path.resolve(input.path)
    const target = realTarget(logical)
    const root = input.workspace.map(realTarget).find((dir) => inside(dir, target))
    const identity = (() => {
      try {
        return statSync(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
    })()
    const hardlinked = identity?.isFile() && identity.nlink > 1
    const permission = (() => {
      if (input.op === "read") {
        if (hardlinked || sensitive(logical, input.home) || sensitive(target, realTarget(input.home)))
          return "sensitive_read"
        return root ? "read" : "external_read"
      }
      if (config(target) || config(logical)) return "config_write"
      if (!root) return "external_write"
      if (hardlinked) return "protected_write"
      const relative = path.relative(path.resolve(root), target)
      return relative.split(path.sep).some((part) => part.startsWith(".")) ? "protected_write" : "edit"
    })()
    const pattern = PermissionNext.normalizePath(target)
    if (hardlinked) return { permission, pattern, grants: [] }
    if (input.directory) {
      const all = pattern.replace(/\/$/, "") + "/*"
      return { permission, pattern: all, grants: [{ scope: "directory", pattern: all }] }
    }
    return {
      permission,
      pattern,
      grants: [
        { scope: "file", pattern },
        { scope: "directory", pattern: PermissionNext.normalizePath(path.dirname(target)) + "/*" },
      ],
    }
  }

  /**
   * Search tools (glob, grep, ls): one check for the tool itself (so users can deny the whole key), plus a read check
   * on the directory when one is given
   */
  export function search(tool: string, pattern: string, directory?: string): Ask[] {
    const self = { permission: tool, pattern, grants: [] }
    if (!directory) return [self]
    return [self, file({ op: "read", path: directory, directory: true, ...scope() })]
  }

  export type CommandLevel = "readonly" | "normal" | "delete" | "risky" | "forbidden"

  const COMMAND_KEYS: Record<CommandLevel, string> = {
    readonly: "bash_readonly",
    normal: "bash",
    delete: "bash_delete",
    risky: "bash_risky",
    forbidden: "bash_forbidden",
  }

  /**
   * One command segment (each part joined by pipes or && is evaluated separately); prefix backs the "allow commands
   * starting with this for the session" grant
   */
  export function command(input: { command: string; level: CommandLevel; prefix: string }): Ask {
    return {
      permission: COMMAND_KEYS[input.level],
      pattern: input.command,
      grants: [{ scope: "prefix", pattern: `${input.prefix} *` }],
    }
  }

  export function subagent(type: string): Ask {
    return { permission: "subagent", pattern: type, grants: [{ scope: "agent", pattern: type }] }
  }

  export function mcp(server: string, tool: string): Ask {
    const pattern = `${server}/${tool}`
    return { permission: "mcp", pattern, grants: [{ scope: "tool", pattern }] }
  }

  /** A command that may change things, asked about while the sandbox is not ready */
  export function unsandboxed(command: string, prefix: string): Ask {
    return { permission: "bash_unsandboxed", pattern: command, grants: [{ scope: "prefix", pattern: `${prefix} *` }] }
  }

  export function network(host: string): Ask {
    const pattern = host.toLowerCase()
    return { permission: "network", pattern, grants: [{ scope: "domain", pattern }] }
  }
}
