/**
 * Constants injected at build time. In release builds the build script replaces them with literals (the define in
 * apps/cli/script/build.ts). When running from source there is no replacement and the same-named globals are read
 * instead (the CLI entry's product-version sets the version first). They are read on use, not at module load.
 */
declare global {
  const MERAKCODE_VERSION: string | undefined
  const MERAKCODE_CHANNEL: string | undefined
}

export const Build = {
  /** Product version; undefined when running from source without the CLI entry (e.g. engine tests) */
  get version() {
    return typeof MERAKCODE_VERSION === "string" ? MERAKCODE_VERSION : undefined
  },
  /** Release channel such as latest or preview; local when running from source */
  get channel() {
    return typeof MERAKCODE_CHANNEL === "string" ? MERAKCODE_CHANNEL : "local"
  },
}
