/**
 * macOS backend: Seatbelt through /usr/bin/sandbox-exec, which ships with every macOS. No setup needed.
 */
import { existsSync } from "node:fs"
import type { Backend, Status } from "../backend"
import { Seatbelt } from "./profile"

export namespace MacSandbox {
  const EXEC = "/usr/bin/sandbox-exec"

  export function create(): Backend {
    return {
      async status(): Promise<Status> {
        if (process.platform !== "darwin" || !existsSync(EXEC))
          return { status: "unsupported", reason: "sandbox-exec is not available on this system" }
        return { status: "on", backend: "seatbelt" }
      },
      async wrap(input) {
        const { profile, params } = Seatbelt.profile(input.policy)
        const [file, ...args] = Seatbelt.command({ profile, params, shell: input.shell, command: input.command })
        return { file: file!, args, env: input.env }
      },
    }
  }
}
