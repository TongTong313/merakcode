import path from "node:path"
import picomatch from "picomatch"
import { glob, globSync } from "tinyglobby"

export type GlobScanOptions = {
  /** Directory to scan from; defaults to the current working directory */
  cwd?: string
  /** Return absolute paths; defaults to paths relative to cwd */
  absolute?: boolean
  /** Return only files; defaults to true */
  onlyFiles?: boolean
  /** Match files and directories starting with a dot; defaults to false */
  dot?: boolean
  /** Follow symbolic links; defaults to false */
  followSymlinks?: boolean
}

/**
 * File matching: `new Glob(pattern).scan(options)` / `.scanSync()` / `.match(path)`.
 *
 * Scan results use the platform separator (backslash on Windows) and directories have no trailing separator; a
 * missing cwd yields no results. `match` matches dot paths by default, and single-item braces `{name}` expand as usual.
 */
export class Glob {
  readonly pattern: string
  readonly #matcher: (input: string) => boolean

  constructor(pattern: string) {
    this.pattern = expandSingleBraces(pattern)
    this.#matcher = picomatch(this.pattern, { dot: true })
  }

  async *scan(options: GlobScanOptions | string = {}): AsyncGenerator<string> {
    const resolved = typeof options === "string" ? { cwd: options } : options
    const found = await glob(this.pattern, settings(resolved)).catch(missing)
    yield* found.map((file) => output(file, resolved))
  }

  scanSync(options: GlobScanOptions | string = {}): string[] {
    const resolved = typeof options === "string" ? { cwd: options } : options
    try {
      return globSync(this.pattern, settings(resolved)).map((file) => output(file, resolved))
    } catch (error) {
      return missing(error)
    }
  }

  match(input: string): boolean {
    return this.#matcher(input.replaceAll("\\", "/"))
  }
}

function settings(options: GlobScanOptions) {
  return {
    cwd: options.cwd ?? process.cwd(),
    absolute: options.absolute ?? false,
    onlyFiles: options.onlyFiles ?? true,
    dot: options.dot ?? false,
    followSymbolicLinks: options.followSymlinks ?? false,
    expandDirectories: false,
  }
}

function output(file: string, options: GlobScanOptions) {
  const trimmed = file.length > 1 && file.endsWith("/") ? file.slice(0, -1) : file
  return options.absolute ? path.resolve(trimmed) : path.normalize(trimmed)
}

/** Scanning a missing directory yields no results; other errors are rethrown */
function missing(error: unknown): string[] {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
  throw error
}

/** picomatch does not expand single-item braces (`{favicon}`), so drop the braces first */
function expandSingleBraces(pattern: string) {
  return pattern.replace(/\{([^{},]*)\}/g, "$1")
}
