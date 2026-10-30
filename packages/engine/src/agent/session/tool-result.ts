export namespace SessionToolResult {
  export const PLACEHOLDER = "[Old tool result content cleared]"
  export const PROTECTED_TOOLS = new Set(["skill"])

  export function isProtected(tool: string) {
    return PROTECTED_TOOLS.has(tool)
  }
}
