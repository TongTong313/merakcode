import semver from "semver"
import { peekGlobalConfig } from "@merakcode/util/config-peek"
import { Installation } from "./installation"

/** a is a newer version than b (0.2.0 is newer than 0.2.0-beta.1) */
export function newer(a: string, b: string) {
  return semver.valid(a) !== null && semver.valid(b) !== null && semver.gt(a, b)
}

/** Global config `autoupdate`: true (default, upgrade automatically), false (never check), "notify" (notify only). */
function autoupdate(): boolean | "notify" {
  return peekGlobalConfig().autoupdate ?? true
}

/**
 * Background upgrade check after the terminal UI starts. npm and install-script installs upgrade automatically per
 * config; other install methods only report the new version. Returns the result to show the user, or undefined when
 * checking is disabled, the lookup fails or the version is current.
 */
export async function upgrade(): Promise<{ version: string; installed: boolean } | undefined> {
  const mode = autoupdate()
  if (mode === false || process.env.MERAKCODE_DISABLE_AUTOUPDATE) return

  const method = Installation.method()
  const latest = await Installation.latest(method).catch(() => {})
  if (!latest) return
  if (!newer(latest, Installation.VERSION)) return

  if (mode === "notify" || method === "unknown") return { version: latest, installed: false }

  return Installation.upgrade(method, latest).then(
    () => ({ version: latest, installed: true }),
    () => undefined,
  )
}
