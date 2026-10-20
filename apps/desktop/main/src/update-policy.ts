/**
 * Whether this install can update itself. A .deb install cannot replace itself, and macOS refuses to install an
 * update for an unsigned app: both get a link to the download page instead.
 */
export namespace UpdatePolicy {
  export type Decision = {
    mode: "auto" | "manual"
    reason?: "linux-package" | "mac-unsigned"
    allowPrerelease: boolean
  }

  export function decide(input: {
    platform: NodeJS.Platform
    appImage: boolean
    signed: boolean
    version: string
  }): Decision {
    const allowPrerelease = input.version.includes("-")
    if (input.platform === "linux" && !input.appImage)
      return { mode: "manual", reason: "linux-package", allowPrerelease }
    if (input.platform === "darwin" && !input.signed) return { mode: "manual", reason: "mac-unsigned", allowPrerelease }
    return { mode: "auto", allowPrerelease }
  }
}
