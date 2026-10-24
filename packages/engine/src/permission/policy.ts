import os from "os"
import path from "path"
import { Policy } from "@merakcode/sandbox/policy"
import { Instance } from "../project/instance"
import { PermissionNext } from "./next"
import type { PermissionMode } from "./mode"

/**
 * Permission policy: classifies a tool call as an operation (permission key + pattern), then gives the default
 * decision for the session's permission mode.
 *
 * Rule chain order (evaluate takes the last matching rule):
 *   mode defaults -> user rules (config, "always allow", session grants) -> mode enforcement (read-only denies)
 * So in ask and auto mode the user's allows and denies override the defaults, while read-only mode blocks edits and
 * commands regardless of user rules.
 */
export namespace PermissionPolicy {
  export type Mode = PermissionMode.Value
  type Action = PermissionNext.Action

  export type Grant = PermissionNext.Grant

  /** One operation to evaluate */
  export type Ask = PermissionNext.Check

  type Table = Record<string, Record<Mode, Action>>

  const allow = { readonly: "allow", ask: "allow", auto: "allow" } as const
  const ask = { readonly: "ask", ask: "ask", auto: "ask" } as const

  /** Default decision for each operation in the three modes */
  const DEFAULTS: Table = {
    // Unregistered tools (plugins, etc.)
    "*": { readonly: "ask", ask: "ask", auto: "allow" },
    // Read-only tools and internal protocols
    read: allow,
    glob: allow,
    grep: allow,
    ls: allow,
    lsp: allow,
    skill: allow,
    todowrite: allow,
    delegate: allow,
    question: allow,
    plan_enter: allow,
    plan_exit: allow,
    doom_loop: allow,
    external_read: { readonly: "ask", ask: "ask", auto: "allow" },
    sensitive_read: ask,
    // File edits
    edit: { readonly: "deny", ask: "allow", auto: "allow" },
    protected_write: { readonly: "deny", ask: "ask", auto: "allow" },
    external_write: { readonly: "deny", ask: "ask", auto: "ask" },
    // Commands
    bash_readonly: allow,
    bash: { readonly: "deny", ask: "ask", auto: "allow" },
    bash_delete: { readonly: "deny", ask: "ask", auto: "allow" },
    bash_risky: { readonly: "deny", ask: "ask", auto: "ask" },
    // Wiping the system or the home folder, formatting, raw disk writes: only an explicit allow in the config runs them
    bash_forbidden: { readonly: "deny", ask: "deny", auto: "deny" },
    // A command that may change things while the sandbox is not ready (sandbox.mode "preferred")
    bash_unsandboxed: { readonly: "deny", ask: "ask", auto: "ask" },
    sandbox: { readonly: "deny", ask: "ask", auto: "ask" },
    // Subagents, workflows, scheduled tasks, MCP
    subagent: { readonly: "ask", ask: "ask", auto: "allow" },
    workflow_run: { readonly: "ask", ask: "ask", auto: "allow" },
    cron: { readonly: "ask", ask: "ask", auto: "allow" },
    mcp: { readonly: "ask", ask: "ask", auto: "allow" },
    // Network: always ask outside the allowlist
    network: ask,
  }

  /** Permission keys that edit files */
  export const WRITE = ["edit", "protected_write", "external_write"]
  /** Permission keys that run commands, including leaving the sandbox */
  export const COMMAND = [
    "bash_readonly",
    "bash",
    "bash_delete",
    "bash_risky",
    "bash_forbidden",
    "bash_unsandboxed",
    "sandbox",
  ]

  /** Read-only mode denies, placed after user rules */
  const READONLY_DENY = [...WRITE, ...COMMAND.filter((key) => key !== "bash_readonly")]

  /** Hard agent limits: denies whole keys, placed after user rules and grants so no mode can lift them */
  export function deny(...keys: string[]): PermissionNext.Ruleset {
    return keys.map((permission) => ({ permission, pattern: "*", action: "deny" as const }))
  }

  /** Read-only: denies file edits and non-read-only commands */
  export function readonly(): PermissionNext.Ruleset {
    return deny(...READONLY_DENY)
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
    const defaults: PermissionNext.Ruleset = Object.entries(DEFAULTS).map(([permission, actions]) => ({
      permission,
      pattern: "*",
      action: actions[mode],
    }))
    const network = NETWORK_ALLOW.map((pattern) => ({ permission: "network", pattern, action: "allow" as const }))
    return [...defaults, ...network, ...user, ...(mode === "readonly" ? readonly() : [])]
  }

  /** Permission keys unavailable in read-only mode; the UI shows a read-only hint for them */
  export function forbiddenInReadonly(permission: string) {
    return READONLY_DENY.includes(permission)
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
  export const SENSITIVE_HOME_DIRS = Policy.SENSITIVE_HOME_DIRS

  function inside(root: string, target: string) {
    const relative = path.relative(root, target)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }

  export function sensitive(file: string, home: string) {
    const name = path.basename(file)
    if (SENSITIVE_NAMES.some((pattern) => pattern.test(name))) return true
    return SENSITIVE_HOME_DIRS.some((dir) => inside(path.join(home, dir), file))
  }

  /**
   * Classifies a file operation. workspace holds the session's workspace roots (several in multi-root setups), path is
   * absolute.
   * - read: read inside the workspace, external_read outside, sensitive_read for sensitive files
   * - write: edit inside the workspace, protected_write for .git and dotfiles inside it, external_write outside
   */
  export function file(input: {
    op: "read" | "write"
    path: string
    workspace: string[]
    home: string
    /** A directory (search root of ls, glob, grep): evaluated and granted for the whole directory */
    directory?: boolean
  }): Ask {
    const target = path.resolve(input.path)
    const root = input.workspace.find((dir) => inside(path.resolve(dir), target))
    const permission = (() => {
      if (input.op === "read") {
        if (sensitive(target, input.home)) return "sensitive_read"
        return root ? "read" : "external_read"
      }
      if (!root) return "external_write"
      const relative = path.relative(path.resolve(root), target)
      return relative.split(path.sep).some((part) => part.startsWith(".")) ? "protected_write" : "edit"
    })()
    const pattern = PermissionNext.normalizePath(target)
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
