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
  const FIND_WRITE = new Set(["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"])

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

  const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell"])

  type Wrapper = {
    /** Options followed by a separate value */
    values: string[]
    /** NAME=value words set the environment of the wrapped command (env) */
    assignments?: boolean
    /** Positional arguments before the wrapped command (the duration of timeout) */
    positional?: number
    /** Options whose value is a whole command line (env -S) */
    scripts?: string[]
    /** Options that look a command up instead of running it (command -v) */
    lookups?: string[]
    /** Runs the command as another user: high risk whatever the command */
    privileged?: boolean
    /** Options that write the wrapper's own output to a file (time -o) */
    output?: string[]
  }

  /** Commands that run the command after their own options; that command decides the level */
  const WRAPPERS: Record<string, Wrapper> = {
    env: { values: ["-u", "--unset", "-C", "--chdir"], assignments: true, scripts: ["-S", "--split-string"] },
    nice: { values: ["-n", "--adjustment"] },
    nohup: { values: [] },
    command: { values: [], lookups: ["-v", "-V"] },
    builtin: { values: [] },
    exec: { values: ["-a"] },
    time: { values: ["-f", "--format", "-o", "--output"], output: ["-o", "--output", "-a", "--append"] },
    timeout: { values: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
    stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"] },
    ionice: { values: ["-c", "--class", "-n", "--classdata"] },
    xargs: {
      values: [
        "-a",
        "-d",
        "-E",
        "-I",
        "-L",
        "-n",
        "-P",
        "-s",
        "--arg-file",
        "--delimiter",
        "--max-args",
        "--max-procs",
      ],
    },
    sudo: {
      values: ["-u", "-g", "-C", "-D", "-h", "-p", "-R", "-r", "-t", "-T", "-U", "--user", "--group", "--chdir"],
      privileged: true,
    },
    doas: { values: ["-u", "-C"], privileged: true },
    pkexec: { values: ["--user"], privileged: true },
  }

  /**
   * Options a tool takes before its subcommand and the value after them (git -C dir push, pnpm --filter x publish);
   * skipped so the subcommand is recognised
   */
  const GLOBAL_VALUES: Record<string, string[]> = {
    git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"],
    npm: ["-w", "--workspace", "--prefix", "--registry", "--userconfig", "--globalconfig", "--cache", "--loglevel"],
    pnpm: ["-C", "--dir", "-F", "--filter", "--filter-prod", "--workspace-dir", "--reporter", "--loglevel"],
    yarn: ["--cwd", "--cache-folder", "--modules-folder", "--registry", "--mutex"],
    bun: ["--cwd", "-c", "--config"],
  }

  /** git options that set config, which can name programs git runs (core.pager, alias.x=!cmd, ...) */
  const GIT_CONFIG = /^(-c|--config-env|--exec-path=)/

  /** Whether an argument sets an option: a long one as --name or --name=value, a short one alone or in a cluster */
  function sets(args: string[], short: string, long: string[] = []) {
    return args.some(
      (arg) =>
        long.some((name) => arg === name || arg.startsWith(name + "=")) ||
        (!!short && /^-[a-zA-Z0-9]+$/.test(arg) && [...short].some((letter) => arg.slice(1).includes(letter))),
    )
  }

  /** Positional arguments, skipping the value after each option in `values` */
  function positionals(args: string[], values: string[] = []) {
    return args.filter((arg, index) => !arg.startsWith("-") && !values.includes(args[index - 1] ?? ""))
  }

  /**
   * Arguments that make a command on the read-only list write files or run other programs (sort -o out, rg --pre cmd,
   * git diff --output=f); such a call counts as a normal command
   */
  const UNSAFE_ARGS: Record<string, (args: string[]) => boolean> = {
    rg: (args) => sets(args, "", ["--pre"]),
    ag: (args) => sets(args, "", ["--pager"]),
    sort: (args) => sets(args, "o", ["--output", "--compress-program"]),
    uniq: (args) => positionals(args, ["-f", "-s", "-w"]).length > 1,
    tree: (args) => sets(args, "oR", ["--output"]),
    xxd: (args) => sets(args, "r", ["--revert"]) || positionals(args, ["-c", "-g", "-l", "-o", "-s", "-n"]).length > 1,
    file: (args) => sets(args, "C", ["--compile"]),
    date: (args) => sets(args, "s", ["--set"]),
    hostname: (args) => sets(args, "F", ["--file"]) || positionals(args).length > 0,
    "git diff": (args) => sets(args, "", ["--output"]),
    "git log": (args) => sets(args, "", ["--output"]),
    "git show": (args) => sets(args, "", ["--output"]),
    "git whatchanged": (args) => sets(args, "", ["--output"]),
    "git shortlog": (args) => sets(args, "", ["--output"]),
    "git ls-remote": (args) => sets(args, "u", ["--upload-pack"]),
  }

  const SEVERITY: PermissionPolicy.CommandLevel[] = ["readonly", "normal", "delete", "risky", "forbidden"]

  function worst(...levels: PermissionPolicy.CommandLevel[]) {
    return levels.reduce((a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a), "readonly")
  }

  /**
   * Where the command a wrapper (env, nice, sudo, ...) runs starts in `words`. Also returns the command line handed to
   * env -S, whether it only looks a command up, whether a wrapper runs it as another user, and whether a wrapper's own
   * options write a file.
   */
  function unwrap(words: string[]) {
    let start = 0
    let privileged = false
    let writes = false
    for (;;) {
      const wrapper = WRAPPERS[words[start] ?? ""]
      if (!wrapper) return { start, privileged, writes }
      privileged ||= !!wrapper.privileged
      let index = start + 1
      let positional = wrapper.positional ?? 0
      while (index < words.length) {
        const word = words[index]!
        if (word === "--") {
          index++
          break
        }
        if (wrapper.lookups?.includes(word)) return { start: words.length, privileged, writes, lookup: true }
        const script = wrapper.scripts?.find((name) => word === name || word.startsWith(name + "="))
        if (script)
          return {
            start: words.length,
            privileged,
            writes,
            script: word === script ? (words[index + 1] ?? "") : word.slice(script.length + 1),
          }
        if (wrapper.output?.some((name) => word === name || word.startsWith(name + "="))) writes = true
        if (word.startsWith("-") && word.length > 1) {
          index += wrapper.values.includes(word) ? 2 : 1
          continue
        }
        if (wrapper.assignments && /^[A-Za-z_]\w*=/.test(word)) {
          index++
          continue
        }
        if (positional > 0) {
          positional--
          index++
          continue
        }
        break
      }
      start = index
    }
  }

  /** The command line a shell runs with -c (also `eval`); undefined for anything else */
  function scriptOf(words: string[]) {
    const [head = "", ...rest] = words
    if (head === "eval") return rest.join(" ")
    if (!SHELLS.has(head) && head !== "su") return
    const flag = rest.findIndex(
      (word) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word) || word === "--command" || word.toLowerCase() === "-command",
    )
    return flag < 0 ? undefined : (rest[flag + 1] ?? "")
  }

  /** The words without a tool's options before its subcommand, with their positions in `words` */
  function subcommand(words: string[]) {
    const values = GLOBAL_VALUES[words[0] ?? ""]
    const all = words.map((_, index) => index)
    if (!values) return { at: all, configured: false }
    let index = 1
    let configured = false
    while (index < words.length && words[index]!.startsWith("-")) {
      const word = words[index]!
      if (words[0] === "git" && GIT_CONFIG.test(word)) configured = true
      index += values.includes(word) ? 2 : 1
    }
    return { at: [0, ...all.slice(index)], configured }
  }

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

  /** Level of a command whose words are unquoted, with wrappers and the tool's options before its subcommand removed */
  function level(
    words: string[],
    prefix: string,
    redirected: boolean,
    configured: boolean,
  ): PermissionPolicy.CommandLevel {
    const head = words[0] ?? ""
    if (forbidden(words)) return "forbidden"
    if (PRIVILEGE.has(head) || PUBLISH.has(prefix)) return "risky"
    if (DELETE.has(head)) return "delete"
    if (prefix === "git clean") return "delete"
    if (prefix === "git reset" && words.includes("--hard")) return "delete"
    if (head === "find" && words.includes("-delete")) return "delete"
    if (head === "find" && words.some((word) => FIND_WRITE.has(word))) return "normal"
    const args = words.slice(prefix.split(" ").length)
    if (READ_ONLY.has(prefix) && !redirected && !configured && !UNSAFE_ARGS[prefix]?.(args)) return "readonly"
    return "normal"
  }

  /**
   * One command as tokens: its level and session-grant prefix, looking through wrappers (env rm, sudo -u x cmd) and
   * a tool's options before its subcommand (git -C dir push). `inner` is the command that actually runs, when it
   * differs from the whole, so rules written for it match too; `script` is a command line handed to sh -c, eval or
   * env -S, to be analyzed on its own.
   */
  function classify(tokens: string[], redirected: boolean) {
    const words = tokens.map(unquote)
    const wrapped = unwrap(words)
    const rest = words.slice(wrapped.start)
    const sub = subcommand(rest)
    const effective = sub.at.map((index) => rest[index]!)
    const raw = sub.at.map((index) => tokens[wrapped.start + index]!)
    const arity = BashArity.prefix(effective).length
    const prefix = effective.slice(0, arity).join(" ")
    const own = rest.length ? level(effective, prefix, redirected, sub.configured) : redirected ? "normal" : "readonly"
    const script = wrapped.script ?? scriptOf(rest)
    // The grant prefix keeps the words as written, up to the end of the subcommand (`env git -C . push`)
    const end = arity ? wrapped.start + sub.at[arity - 1]! + 1 : BashArity.prefix(tokens).length
    const changed = rest.length > 0 && (wrapped.start > 0 || sub.at.length < rest.length)
    return {
      level: worst(
        own,
        wrapped.privileged ? "risky" : "readonly",
        script === undefined && !wrapped.writes ? "readonly" : "normal",
      ),
      prefix: tokens.slice(0, end).join(" "),
      /** The subcommand as matched against the lists (`git push` for `env git -C . push origin`) */
      name: prefix,
      effective,
      privileged: wrapped.privileged,
      script,
      inner: changed
        ? { text: raw.join(" "), tokens: raw, prefix: raw.slice(0, arity).join(" "), level: own }
        : undefined,
    }
  }

  function inside(roots: string[], target: string) {
    return roots.some((root) => {
      const relative = path.relative(root, target)
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
    })
  }

  /**
   * Path-like arguments: absolute, starting with ~, relative with ../, or named like a credential file (.env,
   * id_rsa, ...) wherever it is. Returns the absolute path, or undefined when the argument does not look like a path.
   */
  function pathOf(token: string, input: { cwd: string; home: string }) {
    const value = unquote(token)
    if (!value || value.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return
    const expanded = value === "~" ? input.home : value.startsWith("~/") ? path.join(input.home, value.slice(2)) : value
    const looksLikePath =
      path.isAbsolute(expanded) ||
      expanded !== value ||
      value.split(/[\\/]/).includes("..") ||
      PermissionPolicy.sensitiveName(expanded)
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

  /** Command lines inside command lines (sh -c "sh -c ...") are followed this deep; deeper ones count as normal */
  const MAX_DEPTH = 4

  export async function analyze(
    command: string,
    input: { cwd: string; workspace: string[]; home: string },
  ): Promise<Result> {
    return analyzeAt(command, input, 0)
  }

  async function analyzeAt(
    command: string,
    input: { cwd: string; workspace: string[]; home: string },
    depth: number,
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
      const found = classify(tokens, own?.write ?? false)
      const segment: Segment = { text, tokens, prefix: found.prefix, level: found.level }
      segments.push(segment)
      if (found.inner) segments.push(found.inner)
      if (found.script !== undefined && depth < MAX_DEPTH) {
        // The command line a shell is handed: its commands are segments too, and the shell is at least as risky
        const nested = await analyzeAt(found.script, input, depth + 1)
        segments.push(...nested.segments)
        for (const tag of nested.tags) tags.add(tag)
        for (const file of nested.paths) paths.add(file)
        segment.level = worst(segment.level, ...nested.segments.map((item) => item.level))
      }
      for (const token of tokens.slice(1)) {
        const target = pathOf(token, input)
        if (!target) continue
        paths.add(target)
        if (!inside(input.workspace, target)) tags.add("external-path")
        if (PermissionPolicy.sensitive(target, input.home)) tags.add("sensitive-path")
      }
      const prefix = found.name
      if (segment.level === "forbidden") tags.add("forbidden")
      if (NETWORK.some((item) => prefix === item || prefix.startsWith(item + " "))) tags.add("network")
      if (found.privileged || PRIVILEGE.has(found.effective[0] ?? "")) tags.add("sudo")
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
        for (const segment of segments)
          if (pipeline.text.includes(segment.text)) segment.level = worst(segment.level, "risky")
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
