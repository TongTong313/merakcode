import { Build } from "@merakcode/util/build"
import { Flag } from "../flag/flag"
import pkg from "../../../package.json"

/**
 * Version and channel of the product the engine ships in, written to session records and the User-Agent of outgoing
 * requests. Checking for and installing updates is the CLI's job (apps/cli/src/cli/installation).
 */
export namespace Installation {
  /**
   * Injected by the build in releases. From source, the CLI entry sets the product version first; without that entry
   * (the engine's own tests) the engine package version is used.
   */
  export const VERSION = Build.version ?? pkg.version
  export const CHANNEL = Build.channel
  export const USER_AGENT = `merakcode/${CHANNEL}/${VERSION}/${Flag.MERAKCODE_CLIENT}`

  export function isLocal() {
    return CHANNEL === "local"
  }
}
