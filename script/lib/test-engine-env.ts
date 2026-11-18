import path from "node:path"

// Give the test engine only system and display settings. Its configuration and
// login shell belong to the fixture. Only loopback can reach an HTTP provider.
export function testEngineEnv(home: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  const system = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "ProgramData",
    "SystemDrive",
    "LANG",
    "LC_ALL",
    "TZ",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_SESSION_TYPE",
    "USER",
    "USERNAME",
    "LOGNAME",
  ]
  for (const name of system) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  const drive = path.parse(home).root.replace(/[\\/]$/, "")
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    ...(process.platform === "win32" ? { HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length) } : {}),
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    MERAKCODE_HOME: home,
    MERAKCODE_DISABLE_CATALOG_FETCH: "1",
    MERAKCODE_FILE_CREDENTIALS: "1",
    HTTP_PROXY: "http://127.0.0.1:0",
    HTTPS_PROXY: "http://127.0.0.1:0",
    NO_PROXY: "127.0.0.1,::1,localhost",
  }
}
