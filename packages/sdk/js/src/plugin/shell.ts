/**
 * The `$` given to plugins: runs commands from tagged templates, in the same shell as the bash tool.
 *
 * Interpolated values are arguments: a string is a single argument (quoted automatically, so the shell does not split
 * or expand it), an array expands to several arguments, and `{ raw: string }` is inserted into the command line as is.
 *
 * ```ts
 * const branch = await $`git rev-parse --abbrev-ref HEAD`.text()
 * await $`git add ${files}`.cwd(worktree)
 * const status = await $`git diff --quiet`.nothrow()
 * ```
 */
export type ShellExpression = string | number | { raw: string } | ShellExpression[]

export interface PluginShell {
  (strings: TemplateStringsArray, ...expressions: ShellExpression[]): PluginShellPromise

  /** Quotes a string by shell rules */
  escape(input: string): string

  /** Returns a `$` with different default environment variables (replacing process.env, not merged with it) */
  env(newEnv?: Record<string, string | undefined>): PluginShell

  /** Returns a `$` with a different default working directory */
  cwd(newCwd?: string): PluginShell

  /** Returns a `$` that does not throw on a non-zero exit code */
  nothrow(): PluginShell

  /** Returns a `$` that throws on a non-zero exit code only if shouldThrow is true */
  throws(shouldThrow: boolean): PluginShell
}

export interface PluginShellPromise extends Promise<PluginShellOutput> {
  /** Working directory for this command */
  cwd(newCwd: string): this

  /** Environment variables for this command (replacing the whole environment) */
  env(newEnv: Record<string, string | undefined> | undefined): this

  /** Collects output without printing it (output is never printed by default; kept for compatibility) */
  quiet(): this

  /** Does not throw on a non-zero exit code */
  nothrow(): this

  /** Throws on a non-zero exit code only if shouldThrow is true */
  throws(shouldThrow: boolean): this

  lines(): AsyncIterable<string>

  text(encoding?: BufferEncoding): Promise<string>

  json(): Promise<any>

  arrayBuffer(): Promise<ArrayBuffer>

  blob(): Promise<Blob>
}

export interface PluginShellOutput {
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly exitCode: number

  text(encoding?: BufferEncoding): string

  json(): any

  arrayBuffer(): ArrayBuffer

  bytes(): Uint8Array

  blob(): Blob
}

/** Error thrown on a non-zero exit, carrying the full output */
export type PluginShellError = Error & PluginShellOutput
