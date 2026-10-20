/**
 * Default session title. The engine writes "prefix + timestamp" on creation, and clients use it to tell whether the
 * model has renamed the session yet. Shared by the engine and clients so a prefix change applies to both.
 */
const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "
const pattern = new RegExp(
  `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
)

export namespace SessionTitle {
  export function create(isChild = false) {
    return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
  }

  export function isDefault(title: string) {
    return pattern.test(title)
  }
}
