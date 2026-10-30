import type { Policy } from "./policy"

export type Status = {
  status: "on" | "off" | "unsupported"
  backend?: "windows-account" | "landlock" | "seatbelt"
  /** Why it is not on, in plain English */
  reason?: string
  /** What this system cannot enforce, e.g. "network-not-enforced" */
  degraded?: string[]
  /** A one-time setup would turn it on */
  installable?: boolean
}

/** How to start one command inside the sandbox */
export type Launch = { file: string; args: string[]; env: Record<string, string> }

/** One operating system's way of enforcing a Policy */
export interface Backend {
  status(): Promise<Status>
  /** One-time setup; `progress` gets plain-English steps */
  setup?(progress?: (step: string) => void): Promise<Status>
  /** Undoes setup */
  reset?(): Promise<Status>
  /** One-time work after setup already exists, so the next command does not pay it. No administrator prompt. */
  warm?(): Promise<void>
  /** Temp folder the sandboxed command can write; undefined means the caller's */
  tmp?(): string
  wrap(input: {
    command: string
    shell: string
    cwd: string
    env: Record<string, string>
    policy: Policy
    /** Loopback port of the sandbox proxy, the only one Linux lets a command connect to */
    proxyPort: number
  }): Promise<Launch & { cleanup?(): void }>
}
