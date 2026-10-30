import { Process } from "@merakcode/util/process"

export interface GitResult {
  exitCode: number
  text(): string | Promise<string>
  stdout: Buffer | ReadableStream<Uint8Array>
  stderr: Buffer | ReadableStream<Uint8Array>
}

/**
 * Runs a git command; a non-zero exit code does not throw (the exit code is 127 when git is missing).
 *
 * stdin is always ignored: when running as an ACP client or session worker, a child that inherits the parent's stdin
 * pipe (which carries protocol data) makes git deadlock on Windows.
 */
export async function git(args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<GitResult> {
  return Process.run(["git", ...args], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    nothrow: true,
  })
}
