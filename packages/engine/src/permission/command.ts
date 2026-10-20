import path from "path"
import { createRequire } from "node:module"
import { Language, type Tree } from "web-tree-sitter"
import { lazy } from "../util/lazy"
import { BashArity } from "./arity"
import { PermissionPolicy } from "./policy"

/**
 * Static analysis before a command runs: tree-sitter splits the command into segments (joined by pipes, && or ;),
 * each gets a level (read-only / normal / delete / risky) and a prefix for the "allow commands starting with this for
 * the session" grant, and risks shown in the approval bar are tagged (paths outside the workspace, network, privilege
 * escalation, deletion).
 */
export namespace CommandAnalysis {
  export type Tag = "external-path" | "sensitive-path" | "network" | "sudo" | "delete" | "publish" | "forbidden"

  export type Segment = {
    /** Full text of the segment, including redirects */
    text: string
    tokens: string[]
    prefix: string
    level: PermissionPolicy.CommandLevel
  }

  export type Result = {
    segments: Segment[]
    tags: Tag[]
    /** The whole command certainly does not modify files, so it can run in parallel with editing tools */
    readOnly: boolean
    /** Path-like arguments as absolute paths: credential ones are asked about, outside ones too for read-only commands */
    paths: string[]
  }

  /**
   * Commands that certainly do not modify the file system. Keys are prefixes from BashArity.prefix, so subcommands
   * such as `git status` are included. Commands that both read and write under one name (git branch, git config, sed,
   * awk, etc.) are excluded; anything uncertain counts as a write. Only these commands run in read-only mode.
   */
  const READ_ONLY = new Set([
    // Inspect files and directories
    "ls",
    "dir",
    "cat",
    "head",
    "tail",
    "wc",
    "stat",
    "du",
    "df",
    "file",
    "tree",
    "find",
    "realpath",
    "basename",
    "dirname",
    "readlink",
    // Text processing (read-only forms)
    "grep",
    "rg",
    "egrep",
    "fgrep",
    "ag",
    "sort",
    "uniq",
    "cut",
    "nl",
    "tac",
    "xxd",
    "od",
    "strings",
    "diff",
    "cmp",
    "jq",
    "column",
    // Environment queries
    "echo",
    "printf",
    "pwd",
    "whoami",
    "hostname",
    "uname",
    "date",
    "which",
    "where",
    "whereis",
    "type",
    "env",
    "printenv",
    "id",
    "groups",
    "ps",
    "top",
    "true",
    "false",
    "sleep",
    // Checksums
    "md5sum",
    "sha1sum",
    "sha256sum",
    "cksum",
    // Read-only git subcommands
    "git status",
    "git diff",
    "git log",
    "git show",
    "git blame",
    "git ls-files",
    "git ls-remote",
    "git rev-parse",
    "git describe",
    "git shortlog",
    "git whatchanged",
    "git cat-file",
    // Read-only package manager subcommands
    "npm view",
    "npm list",
    "npm ls",
    "pip show",
    "pip list",
  ])

  /** find options that modify files or run commands */
  const FIND_WRITE = new Set(["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"])

  const DELETE = new Set(["rm", "rmdir", "unlink", "shred"])

  /** Publish and push commands: they send things off the machine and cannot be undone */
  const PUBLISH = new Set([
    "git push",
    "npm publish",
    "npm unpublish",
    "pnpm publish",
    "yarn publish",
    "bun publish",
    "cargo publish",
    "gem push",
    "twine upload",
    "docker push",
    "gh release",
    "gh pr",
    "helm push",
  ])

  /** Privilege escalation and system-changing commands */
  const PRIVILEGE = new Set(["sudo", "su", "doas", "pkexec", "runas", "mkfs", "dd", "shutdown", "reboot", "chown"])

  /**
   * Command prefixes that access the network. Inside the sandbox, connections still go through proxy approval; this
   * list only drives the hint.
   */
  const NETWORK = [
    "curl",
    "wget",
    "ssh",
    "scp",
    "rsync",
    "git clone",
    "git fetch",
    "git pull",
    "git push",
    "npm install",
    "npm i",
    "npm ci",
    "npm add",
    "pnpm install",
    "pnpm add",
    "pnpm i",
    "yarn add",
    "yarn install",
    "bun install",
    "bun add",
    "pip install",
    "pip3 install",
    "uv add",
    "uv pip",
    "poetry add",
    "poetry install",
    "cargo install",
    "cargo add",
    "go get",
    "go install",
    "brew install",
    "apt install",
    "apt-get install",
    "docker pull",
  ]

  const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "pwsh", "powershell"])

  // tree-sitter only needs the wasm file path (it reads the file itself), so resolving through the package is enough
  const resolveWasm = (asset: string) => createRequire(import.meta.url).resolve(asset)

  export const parser = lazy(async () => {
    const { Parser } = await import("web-tree-sitter")
    const treePath = resolveWasm("web-tree-sitter/web-tree-sitter.wasm")
    await Parser.init({
      locateFile() {
        return treePath
      },
    })
    const language = await Language.load(resolveWasm("tree-sitter-bash/tree-sitter-bash.wasm"))
    const p = new Parser()
    p.setLanguage(language)
    return p
  })

  const TOKEN_TYPES = new Set([
    "command_name",
    "word",
    "string",
    "raw_string",
    "concatenation",
    "simple_expansion",
    "expansion",
    "number",
  ])

  function unquote(token: string) {
    if (token.length >= 2 && (token[0] === "'" || token[0] === '"') && token.at(-1) === token[0])
      return token.slice(1, -1)
    return token
  }

  /** Targets that make a recursive rm or chmod wipe the whole system or the home folder */
  const ROOTS = new Set(["/", "/*", "~", "~/", "~/*", "$HOME", "$HOME/", "$HOME/*", "${HOME}", "C:\\", "C:/"])
  const DISKS = /^of=\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|disk)/
  const FORK_BOMB = /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/

  /** Commands that destroy the system or a disk: denied in every mode unless the config allows them */
  function forbidden(tokens: string[]) {
    const words = tokens.map(unquote)
    const start = PRIVILEGE.has(words[0] ?? "") && words[0] !== "dd" && words[0] !== "mkfs" ? 1 : 0
    const [head = "", ...rest] = words.slice(start)
    const flags = rest.filter((word) => word.startsWith("-"))
    const args = rest.filter((word) => !word.startsWith("-"))
    const recursive = flags.some((flag) => /^-[a-zA-Z]*[rR]/.test(flag) || flag === "--recursive")
    const name = head.toLowerCase()
    if (head === "rm" && recursive && args.some((arg) => ROOTS.has(arg))) return true
    if (head === "chmod" && recursive && args.includes("777") && args.some((arg) => ROOTS.has(arg))) return true
    if (/^mkfs(\.|$)/.test(head)) return true
    if (head === "dd" && rest.some((word) => DISKS.test(word))) return true
    if (name === "format" && args.some((arg) => /^[a-z]:$/i.test(arg))) return true
    return name === "diskpart" || name === "diskpart.exe"
  }

  function level(tokens: string[], prefix: string, redirected: boolean): PermissionPolicy.CommandLevel {
    const head = tokens[0] ?? ""
    if (forbidden(tokens)) return "forbidden"
    if (PRIVILEGE.has(head) || PUBLISH.has(prefix)) return "risky"
    if (DELETE.has(head)) return "delete"
    if (prefix === "git clean") return "delete"
    if (prefix === "git reset" && tokens.includes("--hard")) return "delete"
    if (head === "find" && tokens.includes("-delete")) return "delete"
    if (head === "find" && tokens.some((token) => FIND_WRITE.has(token))) return "normal"
    if (READ_ONLY.has(prefix) && !redirected) return "readonly"
    return "normal"
  }

  function inside(roots: string[], target: string) {
    return roots.some((root) => {
      const relative = path.relative(root, target)
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
    })
  }

  /**
   * Path-like arguments: absolute, starting with ~, or relative with ../. Returns the absolute path, or undefined when
   * the argument does not look like a path.
   */
  function pathOf(token: string, input: { cwd: string; home: string }) {
    const value = unquote(token)
    if (!value || value.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return
    const expanded = value === "~" ? input.home : value.startsWith("~/") ? path.join(input.home, value.slice(2)) : value
    const looksLikePath = path.isAbsolute(expanded) || expanded !== value || value.split(/[\\/]/).includes("..")
    // Devices such as /dev/null do not count
    if (!looksLikePath || expanded.startsWith("/dev/")) return
    return path.resolve(input.cwd, expanded)
  }

  function outside(token: string, input: { cwd: string; workspace: string[]; home: string }) {
    const target = pathOf(token, input)
    return !!target && !inside(input.workspace, target)
  }

  type Node = NonNullable<ReturnType<Tree["rootNode"]["child"]>>

  /** Output redirects that write files; descriptor copies such as `2>&1` and writes to /dev/null do not count */
  function writes(redirect: Node) {
    if (!redirect.text.includes(">")) return false
    if (/>&\s*-?\d*$/.test(redirect.text)) return false
    return redirect.lastChild?.text !== "/dev/null"
  }

  /**
   * Redirects attached to each command (text is shown in the approval bar, write means a file is written).
   * tree-sitter wraps all of `a && b > f` in one redirected_statement, but in bash the redirect belongs only to the
   * last command; for subshells, `{ }` and other compound commands it applies to every command inside.
   */
  function redirects(root: Node) {
    const result = new Map<number, { text: string[]; write: boolean }>()
    for (const statement of root.descendantsOfType("redirected_statement")) {
      if (!statement) continue
      const own = statement.children.filter(
        (child): child is Node => child?.type === "file_redirect" || child?.type === "herestring_redirect",
      )
      const body = statement.childForFieldName("body")
      if (!own.length || !body) continue
      const commands = body.type === "command" ? [body] : body.descendantsOfType("command").filter((item) => !!item)
      const targets = body.type === "list" || body.type === "pipeline" ? commands.slice(-1) : commands
      for (const target of targets) {
        const existing = result.get(target.id)
        result.set(target.id, {
          text: [...(existing?.text ?? []), ...own.map((item) => item.text)],
          write: (existing?.write ?? false) || own.some(writes),
        })
      }
    }
    return result
  }

  export async function analyze(
    command: string,
    input: { cwd: string; workspace: string[]; home: string },
  ): Promise<Result> {
    const tree = await parser().then((p) => p.parse(command))
    if (!tree) throw new Error("Failed to parse command")
    const segments: Segment[] = []
    const tags = new Set<Tag>()
    const paths = new Set<string>()
    const redirected = redirects(tree.rootNode)
    for (const node of tree.rootNode.descendantsOfType("command")) {
      if (!node) continue
      const own = redirected.get(node.id)
      const text = [node.text, ...(own?.text ?? [])].join(" ")
      const tokens: string[] = []
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child && TOKEN_TYPES.has(child.type)) tokens.push(child.text)
      }
      if (!tokens.length || tokens[0] === "cd") continue
      const prefix = BashArity.prefix(tokens).join(" ")
      const segment = { text, tokens, prefix, level: level(tokens, prefix, own?.write ?? false) }
      segments.push(segment)
      for (const token of tokens.slice(1)) {
        const target = pathOf(token, input)
        if (!target) continue
        paths.add(target)
        if (!inside(input.workspace, target)) tags.add("external-path")
        if (PermissionPolicy.sensitive(target, input.home)) tags.add("sensitive-path")
      }
      if (segment.level === "forbidden") tags.add("forbidden")
      if (NETWORK.some((item) => prefix === item || prefix.startsWith(item + " "))) tags.add("network")
      if (PRIVILEGE.has(tokens[0]!)) tags.add("sudo")
      if (segment.level === "delete") tags.add("delete")
      if (PUBLISH.has(prefix)) tags.add("publish")
    }
    // Downloading straight into a shell (curl ... | sh) makes the whole pipeline risky
    for (const pipeline of tree.rootNode.descendantsOfType("pipeline")) {
      if (!pipeline) continue
      const names = pipeline
        .descendantsOfType("command_name")
        .map((name) => name?.text ?? "")
        .filter(Boolean)
      if (names.some((name) => name === "curl" || name === "wget") && names.some((name) => SHELLS.has(name))) {
        for (const segment of segments) if (pipeline.text.includes(segment.text)) segment.level = "risky"
        tags.add("network")
      }
    }
    if (FORK_BOMB.test(command)) {
      if (!segments.length) segments.push({ text: command, tokens: [":"], prefix: ":", level: "forbidden" })
      for (const segment of segments) segment.level = "forbidden"
      tags.add("forbidden")
    }
    // Redirects to files outside the workspace
    for (const redirect of tree.rootNode.descendantsOfType("file_redirect")) {
      const target = redirect && writes(redirect) ? redirect.lastChild?.text : undefined
      if (target && outside(target, input)) tags.add("external-path")
    }
    return {
      segments,
      tags: [...tags],
      readOnly: segments.every((segment) => segment.level === "readonly"),
      paths: [...paths],
    }
  }
}
