// Pure helpers for the run command.
//
// They do not depend on the heavy engine modules (tools, server, provider, agent), so run.ts can re-export them and
// run.handler.ts can reuse them without pulling heavy dependencies into CLI startup.

import { statSync } from "node:fs"
import type { Session } from "@merakcode/sdk/client"
import { Filesystem } from "@merakcode/util/filesystem"
import { I18n } from "../i18n"

/** The list is not ordered by update time; only unarchived root sessions in the current directory are continued. */
export function selectContinueSession(
  sessions: Pick<Session, "id" | "parentID" | "directory" | "time">[],
  directory: string,
) {
  return sessions
    .filter(
      (session) =>
        !session.parentID && session.time.archived == null && Filesystem.sameDirectory(session.directory, directory),
    )
    .sort((a, b) => b.time.updated - a.time.updated || b.time.created - a.time.created || b.id.localeCompare(a.id))[0]
}

export function runDirectoryFailure(error: unknown, directory?: string) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  // On Windows, chdir to a file fails with ENOENT even though the path exists; it is just not a directory.
  if (code === "ENOENT" && directory && statSync(directory, { throwIfNoEntry: false })?.isDirectory() === false) {
    return { reason: "not_directory", message: I18n.t("cli.run.notDirectory") }
  }
  if (code === "ENOENT") return { reason: "directory_missing", message: I18n.t("cli.run.directoryMissing") }
  if (code === "ENOTDIR") return { reason: "not_directory", message: I18n.t("cli.run.notDirectory") }
  return { reason: "directory_unavailable", message: I18n.t("cli.run.directoryUnavailable") }
}

/**
 * Copy shown when a non-interactive run (`merak run`) rejects a permission request. Nobody can approve, so every
 * request that needs asking is rejected, along with the config that would allow it up front. Requests that still ask
 * in auto mode (high-risk commands, writes outside the workspace, sensitive files, domains outside the allowlist) are
 * rejected too, since auto mode deliberately leaves those to a human.
 */
export function permissionDeniedCopy(permission: string, patterns: string[] = []): { uiLine: string; message: string } {
  const rule = JSON.stringify({ permission: { [permission]: Object.fromEntries(patterns.map((p) => [p, "allow"])) } })
  const target = patterns.length ? `${permission}: ${patterns.join(", ")}` : permission
  return {
    uiLine: I18n.t("cli.run.permissionDenied.ui", { target }),
    message: I18n.t("cli.run.permissionDenied.message", { target, rule }),
  }
}
