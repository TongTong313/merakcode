/** Engine-only variables that `Flag.seal()` moves out of process.env so child processes never inherit them */
const SEALED = ["SERVER_PASSWORD", "SERVER_USERNAME", "SERVER_PARENT_PID", "CONFIG_CONTENT"]
const sealed = new Map<string, string>()

/**
 * Reads the product environment variable `MERAKCODE_<name>`. An empty string counts as unset.
 * `OPENCODE_<name>` is not read: two spellings only cause "I set it but nothing happened" confusion.
 */
function env(name: string): string | undefined {
  const own = sealed.get(name) ?? process.env[`MERAKCODE_${name}`]
  return own !== undefined && own !== "" ? own : undefined
}

function truthy(name: string) {
  const value = env(name)?.toLowerCase()
  return value === "true" || value === "1"
}

export namespace Flag {
  /** Reads a product environment variable by its name without the `MERAKCODE_` prefix (for tests and tooling) */
  export const read = env

  /**
   * Keeps the engine password, parent pid and inline config in memory and removes them from process.env,
   * so no process the engine starts can read them. Called once when the server starts listening.
   */
  export function seal() {
    for (const name of SEALED) {
      const value = process.env[`MERAKCODE_${name}`]
      if (value !== undefined) sealed.set(name, value)
      delete process.env[`MERAKCODE_${name}`]
    }
  }

  export function unsealForTest() {
    sealed.clear()
  }

  export const MERAKCODE_GIT_BASH_PATH = env("GIT_BASH_PATH")
  export const MERAKCODE_CONFIG = env("CONFIG")
  export declare const MERAKCODE_CONFIG_DIR: string | undefined
  /** Overrides sandbox.mode for this run: preferred, required or off */
  export declare const MERAKCODE_SANDBOX_MODE: string | undefined
  export declare const MERAKCODE_CONFIG_CONTENT: string | undefined
  export const MERAKCODE_DISABLE_PRUNE = truthy("DISABLE_PRUNE")
  export declare const MERAKCODE_PERMISSION: string | undefined
  /**
   * Non-interactive runs such as the CLI: the Question tool is not registered and callers reject question events
   * automatically. Read at access time (see the getter below).
   */
  export declare const MERAKCODE_NONINTERACTIVE: boolean
  export const MERAKCODE_DISABLE_LSP_DOWNLOAD = truthy("DISABLE_LSP_DOWNLOAD")
  export const MERAKCODE_ENABLE_EXPERIMENTAL_MODELS = truthy("ENABLE_EXPERIMENTAL_MODELS")
  export const MERAKCODE_DISABLE_AUTOCOMPACT = truthy("DISABLE_AUTOCOMPACT")
  export const MERAKCODE_DISABLE_MODELS_FETCH = truthy("DISABLE_MODELS_FETCH")
  export const MERAKCODE_DISABLE_CLAUDE_CODE = truthy("DISABLE_CLAUDE_CODE")
  export const MERAKCODE_DISABLE_CLAUDE_CODE_PROMPT =
    MERAKCODE_DISABLE_CLAUDE_CODE || truthy("DISABLE_CLAUDE_CODE_PROMPT")
  export const MERAKCODE_DISABLE_CLAUDE_CODE_SKILLS =
    MERAKCODE_DISABLE_CLAUDE_CODE || truthy("DISABLE_CLAUDE_CODE_SKILLS")
  export const MERAKCODE_DISABLE_EXTERNAL_SKILLS =
    MERAKCODE_DISABLE_CLAUDE_CODE_SKILLS || truthy("DISABLE_EXTERNAL_SKILLS")
  export declare const MERAKCODE_DISABLE_PROJECT_CONFIG: boolean
  export const MERAKCODE_FAKE_VCS = env("FAKE_VCS")
  export declare const MERAKCODE_CLIENT: string
  export const MERAKCODE_SERVER_PASSWORD = env("SERVER_PASSWORD")
  export const MERAKCODE_SERVER_USERNAME = env("SERVER_USERNAME")
  /** Desktop main process PID; when set, risky endpoints require the peer process to be in its process tree */
  export declare const MERAKCODE_SERVER_PARENT_PID: number | undefined

  // Experimental
  export const MERAKCODE_EXPERIMENTAL = truthy("EXPERIMENTAL")
  export const MERAKCODE_EXPERIMENTAL_FILEWATCHER = truthy("EXPERIMENTAL_FILEWATCHER")
  export const MERAKCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("EXPERIMENTAL_DISABLE_FILEWATCHER")
  /** Disables watching the global and project config files (the cross-process sync fallback), which is on by default */
  export const MERAKCODE_DISABLE_CONFIG_WATCH = truthy("DISABLE_CONFIG_WATCH")
  /** Disables watching skill directories (live sync of external SKILL.md changes), which is on by default */
  export const MERAKCODE_DISABLE_SKILL_WATCH = truthy("DISABLE_SKILL_WATCH")
  /** Disables watching memory directories (drops the MemoryScan cache on in-place edits), which is on by default */
  export const MERAKCODE_DISABLE_MEMORY_WATCH = truthy("DISABLE_MEMORY_WATCH")
  /** Disables rules entirely: neither .merakcode/rules nor .cursor/rules is loaded. Rules are on by default */
  export const MERAKCODE_DISABLE_RULES = truthy("DISABLE_RULES")
  /**
   * Disables the compatibility reading of .cursor/rules, which is on by default.
   * A directory that has native .merakcode/rules ignores its .cursor/rules entirely, the same per-directory fallback
   * as AGENTS.md shadowing CLAUDE.md.
   */
  export const MERAKCODE_DISABLE_CURSOR_RULES = MERAKCODE_DISABLE_RULES || truthy("DISABLE_CURSOR_RULES")
  /** Disables watching rule directories (drops the cache on external .mdc changes), which is on by default */
  export const MERAKCODE_DISABLE_RULE_WATCH = truthy("DISABLE_RULE_WATCH")
  // Re-asserting subdirectory AGENTS.md every turn raises per-turn tokens, so it is off by default;
  // set MERAKCODE_ENABLE_INSTRUCTION_REAFFIRM=1 to turn it on
  export const MERAKCODE_DISABLE_INSTRUCTION_REAFFIRM = !truthy("ENABLE_INSTRUCTION_REAFFIRM")
  export const MERAKCODE_EXPERIMENTAL_ICON_DISCOVERY = MERAKCODE_EXPERIMENTAL || truthy("EXPERIMENTAL_ICON_DISCOVERY")

  export const MERAKCODE_ENABLE_EXA = truthy("ENABLE_EXA") || MERAKCODE_EXPERIMENTAL || truthy("EXPERIMENTAL_EXA")
  export const MERAKCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const MERAKCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const MERAKCODE_EXPERIMENTAL_OXFMT = MERAKCODE_EXPERIMENTAL || truthy("EXPERIMENTAL_OXFMT")
  export const MERAKCODE_EXPERIMENTAL_LSP_TY = truthy("EXPERIMENTAL_LSP_TY")
  export const MERAKCODE_EXPERIMENTAL_LSP_TOOL = MERAKCODE_EXPERIMENTAL || truthy("EXPERIMENTAL_LSP_TOOL")
  export const MERAKCODE_DISABLE_FILETIME_CHECK = truthy("DISABLE_FILETIME_CHECK")
  // Plan/Build mode (plan file plus plan_enter/plan_exit) is on for every client (CLI / desktop / web);
  // MERAKCODE_DISABLE_PLAN_MODE=1 turns it off as a fallback switch
  export const MERAKCODE_PLAN_MODE = !truthy("DISABLE_PLAN_MODE")
  export const MERAKCODE_MODELS_URL = env("MODELS_URL")
  export const MERAKCODE_MODELS_PATH = env("MODELS_PATH")

  function number(name: string) {
    const value = env(name)
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for MERAKCODE_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "MERAKCODE_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for MERAKCODE_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "MERAKCODE_CONFIG_DIR", {
  get() {
    return env("CONFIG_DIR")
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "MERAKCODE_SANDBOX_MODE", {
  get() {
    return env("SANDBOX_MODE")
  },
  enumerable: true,
  configurable: false,
})

// Read at access time: tests and external tooling may set the variable after import
Object.defineProperty(Flag, "MERAKCODE_CONFIG_CONTENT", {
  get() {
    return env("CONFIG_CONTENT")
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "MERAKCODE_PERMISSION", {
  get() {
    return env("PERMISSION")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for MERAKCODE_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "MERAKCODE_CLIENT", {
  get() {
    return env("CLIENT") ?? "cli"
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "MERAKCODE_NONINTERACTIVE", {
  get() {
    return truthy("NONINTERACTIVE")
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "MERAKCODE_SERVER_PARENT_PID", {
  get() {
    const parsed = Number(env("SERVER_PARENT_PID"))
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  },
  enumerable: true,
  configurable: false,
})
