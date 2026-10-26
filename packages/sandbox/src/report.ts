/**
 * Text appended to a sandboxed command's output so the model knows what the sandbox stopped and what it can ask for.
 * Written for the model, so English only.
 */
import { ErrorCode } from "@merakcode/util/error-code"

export namespace Report {
  const DENIED = /EPERM|EACCES|Access is denied|Permission denied|Operation not permitted|Read-only file system/i

  export function render(input: { blocked: string[]; restored: string[]; output: string; exitCode: number | null }) {
    const lines = [
      ...(input.blocked.length
        ? [
            `[${ErrorCode.CATALOG.SANDBOX_NETWORK_BLOCKED.code}] The sandbox blocked network access to: ${input.blocked.join(", ")}. A rule or the user refused these hosts; do not retry them.`,
          ]
        : []),
      ...(input.restored.length
        ? [
            `[${ErrorCode.CATALOG.SANDBOX_WRITE_BLOCKED.code}] The sandbox undid changes to protected files: ${input.restored.join(", ")}. Commands may not change .git/hooks, .git/config or MerakCode's config files (merakcode.json, merakcode.jsonc).`,
          ]
        : []),
      ...(input.exitCode !== 0 && DENIED.test(input.output)
        ? [
            `[${ErrorCode.CATALOG.SANDBOX_WRITE_BLOCKED.code}] The command may have been stopped by the sandbox. If it must write outside the workspace, run it again with writable_paths set to those folders. If that cannot help (for example a non-HTTP network connection), run it with unsandboxed: true. Both need a justification and the user's approval.`,
          ]
        : []),
    ]
    return lines.join("\n")
  }
}
