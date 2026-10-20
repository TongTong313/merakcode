/** Terminal UI flags (MERAKCODE_* environment variables). They only affect the UI; the engine never reads them. */
const value = (name: string) => {
  const raw = process.env[`MERAKCODE_${name}`]
  return raw === undefined || raw === "" ? undefined : raw.toLowerCase()
}
const on = (name: string) => ["true", "1"].includes(value(name) ?? "")

export const TuiFlags = {
  /** Copy on select; off by default on Windows, where right-click already pastes and the two conflict. */
  copyOnSelectDisabled:
    value("EXPERIMENTAL_DISABLE_COPY_ON_SELECT") === undefined
      ? process.platform === "win32"
      : on("EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  markdown: on("EXPERIMENTAL_MARKDOWN"),
  terminalTitleDisabled: on("DISABLE_TERMINAL_TITLE"),
}
