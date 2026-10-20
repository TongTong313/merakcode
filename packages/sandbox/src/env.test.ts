import { describe, expect, test } from "vitest"
import { SandboxEnv } from "./env"

const proxy = "http://cmd1:x@127.0.0.1:4100"
const base = { PATH: "/bin", MERAKCODE_SERVER_PASSWORD: "secret", MERAKCODE_CONFIG_CONTENT: "{}", HOME: "/home/u" }

describe("SandboxEnv.build", () => {
  test("points every proxy variable that tools read at the sandbox proxy", () => {
    const env = SandboxEnv.build({ platform: "linux", proxy, tmp: "/tmp/sbx", base })
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"])
      expect(env[key], key).toBe(proxy)
    expect(env.npm_config_proxy).toBe(proxy)
    expect(env.npm_config_https_proxy).toBe(proxy)
  })

  test("NO_PROXY keeps loopback direct on Windows and macOS, and sends everything through the proxy on Linux", () => {
    for (const platform of ["win32", "darwin"] as const) {
      const env = SandboxEnv.build({ platform, proxy, tmp: "/tmp/sbx", base })
      expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1")
      expect(env.no_proxy).toBe("localhost,127.0.0.1,::1")
    }
    expect(SandboxEnv.build({ platform: "linux", proxy, tmp: "/tmp/sbx", base }).NO_PROXY).toBe("")
  })

  test("temp variables point at the sandbox temp dir", () => {
    const env = SandboxEnv.build({ platform: "win32", proxy, tmp: "C:\\sbx\\tmp", base })
    expect([env.TEMP, env.TMP, env.TMPDIR]).toEqual(["C:\\sbx\\tmp", "C:\\sbx\\tmp", "C:\\sbx\\tmp"])
  })

  test("on Windows git trusts the workspace even though the sandbox account does not own it", () => {
    const env = SandboxEnv.build({ platform: "win32", proxy, tmp: "C:\\t", base })
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" })
    const added = SandboxEnv.build({
      platform: "win32",
      proxy,
      tmp: "C:\\t",
      base: { ...base, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "true" },
    })
    expect(added).toMatchObject({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_KEY_1: "safe.directory",
      GIT_CONFIG_VALUE_1: "*",
    })
    expect(SandboxEnv.build({ platform: "linux", proxy, tmp: "/t", base }).GIT_CONFIG_COUNT).toBeUndefined()
  })

  test("the engine's own secrets never reach the command; everything else is kept", () => {
    const env = SandboxEnv.build({ platform: "linux", proxy, tmp: "/t", base })
    expect(env.MERAKCODE_SERVER_PASSWORD).toBeUndefined()
    expect(env.MERAKCODE_CONFIG_CONTENT).toBeUndefined()
    expect(env.PATH).toBe("/bin")
    expect(env.HOME).toBe("/home/u")
  })
})
