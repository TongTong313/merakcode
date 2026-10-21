import semver from "semver"

/** a is a newer version than b (0.2.0 is newer than 0.2.0-beta.1) */
export function newer(a: string, b: string) {
  return semver.valid(a) !== null && semver.valid(b) !== null && semver.gt(a, b)
}
