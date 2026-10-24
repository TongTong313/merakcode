// Types of merakcode-adapter.mjs. Generated from @merakcode/sdk/adapter; do not edit.
/**
 * Member adapters: small programs that let a collaboration group in MerakCode give tasks to a coding CLI.
 *
 * MerakCode starts the adapter and talks to it on stdin and stdout, one JSON-RPC 2.0 message per line (the member
 * protocol). The adapter drives its CLI however that CLI works, and hands every step, permission request and question
 * to MerakCode, which applies the user's permission mode and asks the user when needed. One process does one task.
 *
 * Needs only Node, so it also ships as a single file that an adapter can sit next to.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
/**
 * Starts a CLI: node:child_process spawn with the same arguments and result, which also starts a CLI installed by npm
 * on Windows (a .cmd shim, which spawn cannot start), passing its arguments unchanged
 */
export declare const spawn: typeof nodeSpawn
/**
 * Ends a CLI and everything it started (on Windows the CLI behind an npm shim is the shim's own child), and resolves
 * once that is done. A CLI whose input is still open is asked first by closing it, and gets a moment to exit.
 */
export declare function stop(child: ChildProcess): Promise<void>
/**
 * The first line a CLI prints for --version, or why it gives none: not installed, failing, or not answering in time
 * (it is stopped then). For inspect, which must not start any work.
 */
export declare function version(command: string): Promise<{
  version?: string
  unavailable?: string
}>
/** Version of the member protocol */
export declare const PROTOCOL = 1
/** The user's permission mode in the group */
export type Mode = "readonly" | "ask" | "auto"
/**
 * The product as configured in MerakCode. command and args are the CLI and extra arguments the user set; an adapter
 * written for one CLI may ignore them. resumeArgs and sessionLine are a one-shot product's settings.
 */
export type Product = {
  id: string
  title: string
  command?: string
  args?: string[]
  resumeArgs?: string[]
  sessionLine?: string
}
/** What the adapter reports about its CLI, without running a task */
export type Info = {
  name: string
  /** Version of the CLI, shown in settings */
  version?: string
  /** Where the CLI is on this machine */
  path?: string
  /** Lowest version known to work well; an older one is shown with a hint to upgrade */
  recommended?: string
  /** Command that upgrades the CLI */
  upgrade?: string
  /** Why the CLI cannot take a task now, such as not being installed */
  unavailable?: string
}
export type Task = {
  /** The member's prompt: its duty, the group's state and the task */
  prompt: string
  /** The project directory to work in */
  cwd: string
  mode: Mode
  /** The member's private session from its last task, to continue */
  resume?: string
}
/** Something the member did, shown live in its chat bubble */
export type Step = {
  tool: string
  detail?: string
}
/** An operation the CLI wants to do; MerakCode decides it with the same rules as its own tools */
export type Permission =
  | {
      kind: "write"
      paths: string[]
    }
  | {
      kind: "command"
      command: string
    }
  | {
      kind: "network"
      host: string
      url?: string
    }
  | {
      kind: "read"
      paths: string[]
    }
  | {
      kind: "tool"
      name: string
      detail?: string
    }
/** MerakCode's answer; a refusal says why, for the CLI to work around */
export type Verdict =
  | {
      allow: true
    }
  | {
      allow: false
      message: string
    }
export type Question = {
  question: string
  /** Very short label */
  header: string
  options: {
    label: string
    description: string
  }[]
  multiple?: boolean
  /** Whether the user may type an answer of their own (default true) */
  custom?: boolean
}
/** The labels the user picked or typed, one list per question */
export type Answer = string[]
export type Result = {
  text: string
  /** The CLI's session, given back as resume with the member's next task */
  sessionId?: string
}
/** How an adapter reaches MerakCode while it works */
export type Host = {
  step(step: Step): void
  permission(request: Permission): Promise<Verdict>
  question(questions: Question[]): Promise<Answer[]>
}
export type Definition = {
  inspect(product: Product): Info | Promise<Info>
  /** Does the task; signal aborts when the user stops the group */
  run(
    task: Task & {
      product: Product
      signal: AbortSignal
    },
    host: Host,
  ): Promise<Result>
}
/** A request still waiting when the other side went away */
export declare class ConnectionClosed extends Error {
  constructor()
}
/**
 * One end of a JSON-RPC 2.0 connection over lines. handlers answer the other side's requests and notifications; a
 * line that is not JSON goes to noise. closed resolves when the lines end, failing what is still waiting for a reply.
 */
export declare function connect(options: {
  lines: AsyncIterable<string>
  send: (line: string) => void
  handlers: Record<string, (params: any) => unknown>
  noise?: (line: string) => void
}): {
  request<T>(method: string, params?: unknown): Promise<T>
  notify(method: string, params?: unknown): void
  closed: Promise<void>
}
/**
 * Runs an adapter on this process's stdin and stdout. console.log goes to stderr, which MerakCode keeps in its log,
 * so stray output cannot break the protocol.
 */
export declare function adapter(definition: Definition): void
/** node merakcode-adapter.mjs check|test -- <adapter command> ["<task>"] */
export declare function cli(argv: string[]): Promise<void>
