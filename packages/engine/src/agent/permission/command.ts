import path from "path"
import { existsSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { Language, type Tree } from "web-tree-sitter"
import { lazy } from "@merakcode/util/lazy"
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
    /** Executable after resolving shell quoting and wrappers; prefix remains the displayed grant scope. */
    program?: string
    level: PermissionPolicy.CommandLevel
  }

  export type Result = {
    /** A standalone local Git history query, executed with restricted arguments and configuration. */
    git?: string[]
    segments: Segment[]
    tags: Tag[]
    /** The whole command certainly does not modify files, so it can run in parallel with editing tools */
    readOnly: boolean
    /** Path-like arguments as absolute paths: credential ones are asked about, outside ones too for read-only commands */
    paths: string[]
  }

  /**
   * Commands that certainly do not modify the file system. Git can execute configured programs; package managers
   * can write logs and caches even during queries. Anything uncertain counts as a write.
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
    "git ls-remote",
    "npm view",
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

  /** Whether an argument sets an option: a long one as --name or --name=value, a short one alone or in a cluster */
  function sets(args: string[], short: string, long: string[] = []) {
    return args.some(
      (arg) =>
        (arg.startsWith("--") && arg.length > 2 && long.some((name) => name.startsWith(arg.split("=")[0]!))) ||
        (!!short && !arg.startsWith("--") && new RegExp(`^-[a-zA-Z0-9]*[${short}]`).test(arg)),
    )
  }

  // Only known non-writing long options may keep sort read-only; unknown options require normal admission.
  const SORT_READ_OPTIONS = new Set([
    "--ignore-leading-blanks",
    "--check",
    "--dictionary-order",
    "--ignore-case",
    "--general-numeric-sort",
    "--ignore-nonprinting",
    "--key",
    "--month-sort",
    "--merge",
    "--human-numeric-sort",
    "--numeric-sort",
    "--random-sort",
    "--random-source",
    "--reverse",
    "--stable",
    "--buffer-size",
    "--field-separator",
    "--parallel",
    "--unique",
    "--version-sort",
    "--zero-terminated",
    "--batch-size",
    "--help",
    "--version",
    "--debug",
    "--sort",
  ])

  // Keep common search options read-only; external processors and unknown long options need normal admission.
  const RG_READ_OPTIONS = new Set([
    "--regexp",
    "--file",
    "--glob",
    "--iglob",
    "--type",
    "--type-not",
    "--type-add",
    "--type-clear",
    "--ignore-case",
    "--case-sensitive",
    "--smart-case",
    "--fixed-strings",
    "--word-regexp",
    "--line-regexp",
    "--line-number",
    "--no-line-number",
    "--column",
    "--heading",
    "--no-heading",
    "--with-filename",
    "--no-filename",
    "--context",
    "--before-context",
    "--after-context",
    "--context-separator",
    "--no-context-separator",
    "--count",
    "--count-matches",
    "--files",
    "--files-with-matches",
    "--files-without-match",
    "--quiet",
    "--hidden",
    "--no-ignore",
    "--no-ignore-vcs",
    "--no-ignore-parent",
    "--ignore-file",
    "--follow",
    "--max-count",
    "--max-depth",
    "--max-filesize",
    "--max-columns",
    "--max-columns-preview",
    "--threads",
    "--encoding",
    "--text",
    "--binary",
    "--null",
    "--null-data",
    "--multiline",
    "--multiline-dotall",
    "--pcre2",
    "--auto-hybrid-regex",
    "--engine",
    "--regex-size-limit",
    "--dfa-size-limit",
    "--replace",
    "--only-matching",
    "--invert-match",
    "--passthru",
    "--json",
    "--stats",
    "--sort",
    "--sortr",
    "--color",
    "--colors",
    "--hyperlink-format",
    "--trim",
    "--crlf",
    "--no-config",
    "--no-messages",
    "--line-buffered",
    "--block-buffered",
    "--debug",
    "--trace",
    "--help",
    "--version",
    "--type-list",
  ])

  const RG_VALUES = [
    "-e",
    "--regexp",
    "-f",
    "--file",
    "-g",
    "--glob",
    "--iglob",
    "-t",
    "--type",
    "-T",
    "--type-not",
    "--type-add",
    "--type-clear",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "--context-separator",
    "--ignore-file",
    "-m",
    "--max-count",
    "--max-depth",
    "--max-filesize",
    "-M",
    "--max-columns",
    "-j",
    "--threads",
    "-E",
    "--encoding",
    "--engine",
    "--regex-size-limit",
    "--dfa-size-limit",
    "-r",
    "--replace",
    "--sort",
    "--sortr",
    "--color",
    "--colors",
    "--hyperlink-format",
  ]

  /** Positional arguments, skipping the value after each option in `values` */
  function positionals(args: string[], values: string[] = []) {
    return args.filter((arg, index) => !arg.startsWith("-") && !values.includes(args[index - 1] ?? ""))
  }

  /**
   * Arguments that make a command on the read-only list write files or run other programs (sort -o out, rg --pre cmd,
   * sort -o out); such a call counts as a normal command
   */
  const UNSAFE_ARGS: Record<string, (args: string[]) => boolean> = {
    printf: (args) => {
      const format = args[0] === "--" ? args[1] : args[0]
      // Shell printf can assign variables through -v and %n. Only known text-output formats are read-only.
      return (
        format === undefined ||
        (args[0] !== "--" && format.startsWith("-")) ||
        format.replace(/%%|%[sbq]/g, "").includes("%")
      )
    },
    rg: (args) =>
      sets(args, "fz", ["--file", "--pre", "--hostname-bin", "--search-zip"]) ||
      args.some((arg) => arg.startsWith("--") && arg !== "--" && !RG_READ_OPTIONS.has(arg.split("=")[0]!)) ||
      positionals(args, RG_VALUES).length <= (sets(args, "e", ["--regexp"]) ? 0 : 1),
    grep: (args) => sets(args, "rRfd", ["--recursive", "--dereference-recursive", "--file", "--directories"]),
    egrep: (args) => sets(args, "rRfd", ["--recursive", "--dereference-recursive", "--file", "--directories"]),
    fgrep: (args) => sets(args, "rRfd", ["--recursive", "--dereference-recursive", "--file", "--directories"]),
    sort: (args) =>
      sets(args, "oT", ["--output", "--compress-program"]) ||
      args.some((arg) => arg.startsWith("--") && arg !== "--" && !SORT_READ_OPTIONS.has(arg.split("=")[0]!)),
    uniq: (args) => positionals(args, ["-f", "-s", "-w"]).length > 1,
    tree: (args) => sets(args, "oR", ["--output"]),
    xxd: (args) => sets(args, "r", ["--revert"]) || positionals(args, ["-c", "-g", "-l", "-o", "-s", "-n"]).length > 1,
    file: (args) =>
      sets(args, "CfmzZ", ["--compile", "--files-from", "--magic-file", "--uncompress", "--uncompress-noreport"]),
    jq: (args) => sets(args, "f", ["--from-file"]),
    wc: (args) => sets(args, "", ["--files0-from"]),
    diff: (args) => sets(args, "r", ["--recursive"]),
    md5sum: (args) => sets(args, "c", ["--check"]),
    sha1sum: (args) => sets(args, "c", ["--check"]),
    sha256sum: (args) => sets(args, "c", ["--check"]),
    cksum: (args) => sets(args, "c", ["--check"]),
    date: (args) => {
      for (let index = 0; index < args.length; index++) {
        const arg = args[index]!
        if (arg.startsWith("+") || /^-[uR]+$/.test(arg)) continue
        if (["--utc", "--universal", "--rfc-email", "--help", "--version"].includes(arg)) continue
        if (/^--(date|reference)=/.test(arg)) continue
        if (["-d", "--date", "-r", "--reference"].includes(arg) && args[index + 1] !== undefined) {
          index++
          continue
        }
        return true
      }
      return false
    },
    hostname: (args) => sets(args, "F", ["--file"]) || positionals(args).length > 0,
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
      // xargs supplies additional arguments at runtime, including options that can make a read command write.
      writes ||= words[start] === "xargs"
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
          if (wrapper.assignments || !wrapper.values.includes(word.split("=")[0]!)) writes = true
          index += wrapper.values.includes(word) ? 2 : 1
          continue
        }
        if (wrapper.assignments && /^[A-Za-z_]\w*=/.test(word)) {
          writes = true
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
      if (words[start] === "env" && index === words.length) writes = true
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
    if (!values) return { at: all }
    let index = 1
    while (index < words.length && words[index]!.startsWith("-")) {
      const word = words[index]!
      index += values.includes(word) ? 2 : 1
    }
    return { at: [0, ...all.slice(index)] }
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

  /** Resolve shell quoting without executing expansions or substitutions. */
  function shellWord(token: string) {
    let value = ""
    let quote: string | undefined
    let known = true
    for (let index = 0; index < token.length; index++) {
      const char = token[index]!
      const next = token[index + 1]
      if (
        char === "\\" &&
        quote !== "'" &&
        next !== undefined &&
        (quote !== '"' || ["$", "`", '"', "\\", "\n"].includes(next))
      ) {
        if (next !== "\n") value += next
        index++
        continue
      }
      if ((char === "'" || char === '"') && (!quote || quote === char)) {
        quote = quote ? undefined : char
        continue
      }
      if (quote !== "'" && (char === "$" || char === "`")) known = false
      // Unquoted glob and brace expansions can change both argument values and argument count.
      if (!quote && ["*", "?", "[", "{"].includes(char)) known = false
      value += char
    }
    return { value, known: known && !quote }
  }

  function unquote(token: string) {
    return shellWord(token).value
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
  function level(words: string[], prefix: string, redirected: boolean): PermissionPolicy.CommandLevel {
    const head = words[0] ?? ""
    if (forbidden(words)) return "forbidden"
    if (PRIVILEGE.has(head) || PUBLISH.has(prefix)) return "risky"
    if (DELETE.has(head)) return "delete"
    if (prefix === "git clean") return "delete"
    if (prefix === "git reset" && words.includes("--hard")) return "delete"
    if (head === "find" && words.includes("-delete")) return "delete"
    if (head === "find" && words.some((word) => FIND_WRITE.has(word))) return "normal"
    const args = words.slice(prefix.split(" ").length)
    if (READ_ONLY.has(prefix) && !redirected && !UNSAFE_ARGS[prefix]?.(args)) return "readonly"
    return "normal"
  }

  /**
   * One command as tokens: its level and session-grant prefix, looking through wrappers (env rm, sudo -u x cmd) and
   * a tool's options before its subcommand (git -C dir push). `inner` is the command that actually runs, when it
   * differs from the whole, so rules written for it match too; `script` is a command line handed to sh -c, eval or
   * env -S, to be analyzed on its own.
   */
  function classify(tokens: string[], redirected: boolean) {
    const parsed = tokens.map(shellWord)
    const words = parsed.map((word) => word.value)
    const wrapped = unwrap(words)
    const rest = words.slice(wrapped.start)
    const sub = subcommand(rest)
    const effective = sub.at.map((index) => rest[index]!)
    const raw = sub.at.map((index) => tokens[wrapped.start + index]!)
    const arity = BashArity.prefix(effective).length
    const prefix = effective.slice(0, arity).join(" ")
    const own = rest.length ? level(effective, prefix, redirected) : redirected ? "normal" : "readonly"
    const script = wrapped.script ?? scriptOf(rest)
    // The grant prefix keeps the words as written, up to the end of the subcommand (`env git -C . push`)
    const end = arity ? wrapped.start + sub.at[arity - 1]! + 1 : BashArity.prefix(tokens).length
    const changed = rest.length > 0 && (wrapped.start > 0 || sub.at.length < rest.length)
    return {
      level: worst(
        own,
        parsed.every((word) => word.known) ? "readonly" : "normal",
        wrapped.privileged ? "risky" : "readonly",
        script === undefined && !wrapped.writes ? "readonly" : "normal",
      ),
      prefix: tokens.slice(0, end).join(" "),
      /** The subcommand as matched against the lists (`git push` for `env git -C . push origin`) */
      name: prefix,
      effective,
      literalFrom: words.indexOf("--", wrapped.start + 1),
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
   * Explicit paths and existing file operands, including --option=file. Existing ordinary names must be checked
   * too: they can be symbolic or hard links to credentials.
   */
  function pathOf(token: string, input: { cwd: string; home: string }, optionValue = false) {
    const word = /^[a-z]:\\/i.test(token) ? token : unquote(token)
    const value = optionValue && word.startsWith("--") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : word
    if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return
    const expanded = value === "~" ? input.home : value.startsWith("~/") ? path.join(input.home, value.slice(2)) : value
    const looksLikePath =
      path.isAbsolute(expanded) ||
      expanded !== value ||
      value.split(/[\\/]/).includes("..") ||
      PermissionPolicy.sensitiveName(expanded)
    // Devices such as /dev/null do not count
    const target = path.resolve(input.cwd, expanded)
    if ((!looksLikePath && !existsSync(target)) || expanded.startsWith("/dev/")) return
    return target
  }

  function outside(token: string, input: { cwd: string; workspace: string[]; home: string }) {
    const target = pathOf(token, input)
    return !!target && !inside(input.workspace, target)
  }

  type Node = NonNullable<ReturnType<Tree["rootNode"]["child"]>>

  /** Output redirects that write files; descriptor copies such as `2>&1` and writes to /dev/null do not count */
  function writes(redirect: Node) {
    if (redirect.type !== "file_redirect" || !redirect.children.some((child) => child?.type.includes(">"))) return false
    if (/>&\s*-?\d*$/.test(redirect.text)) return false
    return unquote(redirect.childForFieldName("destination")?.text ?? "") !== "/dev/null"
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

  const GIT_LOG_OPTIONS = new Set([
    "--oneline",
    "--stat",
    "--name-only",
    "--name-status",
    "--all",
    "--graph",
    "--reverse",
    "-p",
  ])

  function gitInspection(root: Node, command: string) {
    const node = root.namedChildren[0]
    if (root.hasError || root.namedChildCount !== 1 || node?.type !== "command" || node.text !== command.trim()) return
    if (node.namedChildren.some((child) => !child || !TOKEN_TYPES.has(child.type))) return
    const words = node.namedChildren.map((child) => shellWord(child!.text))
    if (words.some((word) => !word.known) || words[0]?.value !== "git") return
    const args = words.slice(1).map((word) => word.value)
    const values = GLOBAL_VALUES.git ?? []
    let at = 0
    while (at < args.length && args[at]!.startsWith("-")) at += values.includes(args[at]!) ? 2 : 1
    const name = args[at] ?? ""
    if (name !== "log") return
    const options = args.slice(at + 1)
    for (let index = 0; index < options.length; index++) {
      const option = options[index]!
      if (GIT_LOG_OPTIONS.has(option)) continue
      if (/^-\d+$/.test(option)) continue
      if (["-n", "--max-count"].includes(option) && /^\d+$/.test(options[index + 1] ?? "")) {
        index++
        continue
      }
      if (/^--max-count=\d+$/.test(option)) continue
      if (option === "--") continue
      if (!option.startsWith("-") && /^[\w./~-]+$/.test(option)) continue
      return
    }
    return args.slice(at)
  }

  export async function analyze(
    command: string,
    input: { cwd: string; workspace: string[]; home: string; controlledGit?: boolean },
  ): Promise<Result> {
    return analyzeAt(command, input, 0)
  }

  async function analyzeAt(
    command: string,
    input: { cwd: string; workspace: string[]; home: string; controlledGit?: boolean },
    depth: number,
  ): Promise<Result> {
    const tree = await parser().then((p) => p.parse(command))
    if (!tree) throw new Error("Failed to parse command")
    const segments: Segment[] = []
    const tags = new Set<Tag>()
    const paths = new Set<string>()
    const addPath = (target: string) => {
      paths.add(target)
      const check = PermissionPolicy.file({ op: "read", path: target, ...input })
      if (check.permission === "external_read") tags.add("external-path")
      if (check.permission === "sensitive_read") tags.add("sensitive-path")
    }
    const redirected = redirects(tree.rootNode)
    const git = input.controlledGit && depth === 0 ? gitInspection(tree.rootNode, command) : undefined
    for (const node of tree.rootNode.descendantsOfType("command")) {
      if (!node) continue
      const own = redirected.get(node.id)
      const text = [node.text, ...(own?.text ?? [])].join(" ")
      const tokens: string[] = []
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child && TOKEN_TYPES.has(child.type)) tokens.push(child.text)
      }
      const unsupported = node.namedChildren.some(
        (child) =>
          child && !TOKEN_TYPES.has(child.type) && !["file_redirect", "herestring_redirect"].includes(child.type),
      )
      if (!tokens.length) continue
      // A lone literal cd only changes the disposable shell's directory; a compound command changes later targets.
      if (
        tokens[0] === "cd" &&
        !unsupported &&
        node.parent?.type === "program" &&
        tree.rootNode.namedChildCount === 1 &&
        tokens.every((token) => shellWord(token).known)
      )
        continue
      const found = classify(tokens, own?.write ?? false)
      const segment: Segment = {
        text,
        tokens,
        prefix: found.prefix,
        program: found.effective[0],
        level: unsupported ? worst(found.level, "normal") : found.level,
      }
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
      for (let index = 1; index < tokens.length; index++) {
        const target = pathOf(tokens[index]!, input, found.literalFrom < 0 || index < found.literalFrom)
        if (!target) continue
        addPath(target)
        // Directory searches discover files after admission, including credentials not named by the command.
        if (
          ["rg", "diff"].includes(found.effective[0] ?? "") &&
          statSync(target, { throwIfNoEntry: false })?.isDirectory()
        )
          segment.level = worst(segment.level, "normal")
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
    if (git && segments.length === 1) segments[0]!.level = "readonly"
    // Standalone redirects and redirects on skipped commands (cd) still write files.
    // Parser errors and shell-state changes cannot establish that a command is read-only.
    const fileRedirects = tree.rootNode.descendantsOfType("file_redirect")
    const networkRedirect = fileRedirects.some((redirect) =>
      /^\/dev\/(tcp|udp)\//.test(unquote(redirect?.childForFieldName("destination")?.text ?? "")),
    )
    if (networkRedirect) tags.add("network")
    if (
      (tree.rootNode.hasError ||
        networkRedirect ||
        tree.rootNode.descendantsOfType([
          "variable_assignment",
          "for_statement",
          "c_style_for_statement",
          "function_definition",
          "declaration_command",
          "unset_command",
          "arithmetic_expansion",
          "simple_expansion",
          "expansion",
        ]).length > 0 ||
        tree.rootNode.descendantsOfType("compound_statement").some((node) => node?.firstChild?.text === "((") ||
        fileRedirects.some(
          (redirect) =>
            redirect && (writes(redirect) || !shellWord(redirect.childForFieldName("destination")?.text ?? "").known),
        )) &&
      segments.every((segment) => segment.level === "readonly")
    )
      segments.push({ text: command, tokens: [command], prefix: command, level: "normal" })
    // Literal input files need the same credential and outside-workspace checks as ordinary command arguments.
    for (const redirect of fileRedirects) {
      const destination = redirect?.childForFieldName("destination")?.text
      if (!redirect || !destination || /[<>]&\s*-?\d*$/.test(redirect.text)) continue
      if (writes(redirect)) {
        if (outside(destination, input)) tags.add("external-path")
        continue
      }
      const target = pathOf(destination, input)
      if (!target) continue
      addPath(target)
    }
    return {
      ...(git ? { git } : {}),
      segments,
      tags: [...tags],
      readOnly: segments.every((segment) => segment.level === "readonly"),
      paths: [...paths],
    }
  }
}
