import { execFile } from "node:child_process"
import type { Settings } from "./settings"

/** MRK codes of a failed `service install` and `service uninstall` */
const FAILED = { install: "MRK-5014", uninstall: "MRK-5015" } as const

type Action = keyof typeof FAILED

export type LoginOptions = {
  settings: Pick<Settings, "loginProgram">
  /** The engine program that `service install` registers: the login item runs this path at every login */
  program: () => string
  log: (message: string, extra?: Record<string, unknown>) => void
}

/** Runs `<program> service <action>`; a failure becomes an Error whose message is the MRK code the engine printed */
function run(program: string, action: Action) {
  return new Promise<void>((resolve, reject) => {
    execFile(program, ["service", action], { windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) => {
      if (!error) return resolve()
      reject(new Error(/MRK-\d{4}/.exec(`${stdout}\n${stderr}`)?.[0] ?? FAILED[action], { cause: error }))
    })
  })
}

/**
 * The "start at login" switch. The login item stores the path of the engine program, which moves when the app
 * updates; so while the switch is on, the path that was registered is remembered, and at every app start a different
 * current path registers the login item again. Turning the switch off removes the login item and remembers nothing.
 */
export class Login {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private options: LoginOptions) {}

  get enabled() {
    return this.options.settings.loginProgram !== undefined
  }

  /** Turns the login item on or off. Calls run one after another; on failure the switch keeps its state */
  set(enabled: boolean) {
    return this.later(async () => {
      if (enabled) return this.install()
      await run(this.options.program(), "uninstall")
      this.options.settings.loginProgram = undefined
    })
  }

  /** At app start: registers the login item again when it is on and the engine program is somewhere else now */
  sync() {
    return this.later(async () => {
      const recorded = this.options.settings.loginProgram
      if (recorded === undefined || recorded === this.options.program()) return
      await this.install().catch((error: unknown) =>
        this.options.log("login item not updated", { error: error instanceof Error ? error.message : String(error) }),
      )
    })
  }

  private async install() {
    const program = this.options.program()
    await run(program, "install")
    this.options.settings.loginProgram = program
  }

  private later<T>(task: () => Promise<T>) {
    const next = this.queue.then(task)
    this.queue = next.catch(() => undefined)
    return next
  }
}
