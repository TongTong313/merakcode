/**
 * Single source of truth for public project information.
 * After changing it, run `pnpm sync:project` to update LICENSE and the repository fields in every package.json.
 */
export namespace Project {
  export const NAME = "MerakCode"
  export const REPOSITORY = "TongTong313/merakcode"
  /** Copyright holder in LICENSE */
  export const AUTHOR = "Tong Tong"
  /** Maintainer contact, used where a package format requires an email (deb) */
  export const EMAIL = "tongtong950313@gmail.com"
  /** First copyright year in LICENSE */
  export const SINCE = 2026
  export const HOMEPAGE = `https://github.com/${REPOSITORY}`
  export const RELEASES = `${HOMEPAGE}/releases`
  export const ISSUES = `${HOMEPAGE}/issues`
}
