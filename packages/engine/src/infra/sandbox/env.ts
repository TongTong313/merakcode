/**
 * Environment of a sandboxed command: proxy variables for every common tool, temp dirs inside the sandbox, and none
 * of the engine's own secrets.
 */
import { ChildEnv } from "@merakcode/util/child-env"

export namespace SandboxEnv {
  const PROXY = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "npm_config_proxy", "npm_config_https_proxy"]

  export function build(input: {
    platform: NodeJS.Platform
    /** Proxy URL for this command, see SandboxProxy.Handle.url */
    proxy: string
    tmp: string
    base: Record<string, string | undefined>
  }): Record<string, string> {
    const env = ChildEnv.build({ base: input.base })
    for (const key of PROXY) {
      env[key] = input.proxy
      if (key.toUpperCase() === key) env[key.toLowerCase()] = input.proxy
    }
    // Linux allows TCP only to the proxy port, so loopback goes through the proxy too
    const direct = input.platform === "linux" ? "" : "localhost,127.0.0.1,::1"
    env.NO_PROXY = direct
    env.no_proxy = direct
    env.TEMP = input.tmp
    env.TMP = input.tmp
    env.TMPDIR = input.tmp
    if (input.platform === "win32") {
      // The sandbox account does not own the workspace; without this git refuses with "dubious ownership"
      const count = Number(env.GIT_CONFIG_COUNT) || 0
      env[`GIT_CONFIG_KEY_${count}`] = "safe.directory"
      env[`GIT_CONFIG_VALUE_${count}`] = "*"
      env.GIT_CONFIG_COUNT = String(count + 1)
    }
    return env
  }
}
