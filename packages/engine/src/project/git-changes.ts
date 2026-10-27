import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import z from "zod"
import { NamedError } from "@merakcode/util/error"
import { Process } from "@merakcode/util/process"
import { Instance } from "./instance"
import { Checkout } from "./checkout"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"

/** Git snapshots are independent of conversation review baselines. */
export namespace GitChanges {
  export const FailedError = NamedError.create("GitChangesFailedError", z.object({ message: z.string() }))
  export const StaleError = NamedError.create("GitChangesStaleError", z.object({ message: z.string() }))
  export const Event = { Updated: BusEvent.define("vcs.changes.updated", z.object({})) }
  export const File = z
    .object({
      file: z.string(),
      status: z.enum(["added", "modified", "deleted", "conflicted"]),
      version: z.string(),
    })
    .meta({ ref: "GitChangeFile" })
  export const Result = z
    .object({
      checkout: z.string().nullable(),
      staged: File.array(),
      unstaged: File.array(),
    })
    .meta({ ref: "GitChangesResult" })
  export type Result = z.infer<typeof Result>
  export const Input = z.object({
    expectedCheckout: z.string().nullable(),
    files: z.object({ file: z.string(), version: z.string() }).array().min(1),
  })
  export type Input = z.infer<typeof Input>

  async function git(args: string[]) {
    const result = await Process.run(["git", "--literal-pathspecs", "-c", "core.quotepath=off", ...args], {
      cwd: Instance.worktree,
      nothrow: true,
    })
    if (result.exitCode !== 0) throw new FailedError({ message: result.stderr.toString().trim() })
    return result.text()
  }

  async function content(file: string) {
    const absolute = path.join(Instance.worktree, file)
    const stat = await fs.lstat(absolute).catch(() => undefined)
    if (!stat) return Buffer.from("missing\0")
    if (stat.isSymbolicLink()) return Buffer.from(`symlink\0${await fs.readlink(absolute)}`)
    if (stat.isDirectory()) {
      const head = await git(["-C", absolute, "rev-parse", "--verify", "HEAD"]).catch(() => "unborn")
      return Buffer.from(`directory\0${head}\0${await git(["diff", "--no-ext-diff", "--", file])}`)
    }
    return Buffer.concat([Buffer.from(`file:${stat.mode & 0o7777}\0`), await fs.readFile(absolute)])
  }

  export async function get(): Promise<Result> {
    const current = await Checkout.current()
    if (!current) return { checkout: null, staged: [], unstaged: [] }
    const [raw, index] = await Promise.all([
      git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]),
      git(["ls-files", "--stage", "-z"]),
    ])
    const indexed = new Map(
      index
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const at = entry.indexOf("\t")
          return [entry.slice(at + 1), entry.slice(0, at)]
        }),
    )
    const staged: Result["staged"] = []
    const unstaged: Result["unstaged"] = []
    for (const entry of raw.split("\0").filter(Boolean)) {
      const file = entry.slice(3)
      const [x, y] = entry
      const conflict = x === "U" || y === "U" || entry.startsWith("AA") || entry.startsWith("DD")
      const status = (code: string | undefined) =>
        conflict
          ? ("conflicted" as const)
          : code === "A" || code === "?"
            ? ("added" as const)
            : code === "D"
              ? ("deleted" as const)
              : ("modified" as const)
      const hash = () => createHash("sha256").update(`${file}\0${indexed.get(file) ?? ""}\0`)
      if (x !== " " && x !== "?") staged.push({ file, status: status(x), version: hash().digest("hex") })
      if (y !== " ")
        unstaged.push({
          file,
          status: status(y),
          version: hash()
            .update(await content(file))
            .digest("hex"),
        })
    }
    await Checkout.assert(current.checkout)
    const sort = (a: { file: string }, b: { file: string }) => a.file.localeCompare(b.file)
    return { checkout: current.checkout, staged: staged.sort(sort), unstaged: unstaged.sort(sort) }
  }

  const pending = new Map<string, Promise<unknown>>()
  function change(input: Input, group: "staged" | "unstaged", write: (files: string[]) => Promise<unknown>) {
    const directory = Instance.worktree
    const task = (pending.get(directory) ?? Promise.resolve())
      .catch(() => {})
      .then(() =>
        Checkout.activity(async () => {
          await Checkout.assert(input.expectedCheckout)
          const before = await get()
          if (!before.checkout) throw new FailedError({ message: "Not a Git repository" })
          const files = [
            ...new Set(
              input.files.map((target) => {
                const file = before[group].find((file) => file.file === target.file)
                if (!file || file.version !== target.version)
                  throw new StaleError({ message: `${target.file} changed; refresh Git changes` })
                return file.file
              }),
            ),
          ]
          await Checkout.assert(input.expectedCheckout)
          await write(files)
          await Bus.publish(Event.Updated, {})
          return get()
        }),
      )
    pending.set(directory, task)
    return task.finally(() => {
      if (pending.get(directory) === task) pending.delete(directory)
    })
  }

  export const stage = (input: Input) =>
    change(Input.parse(input), "unstaged", (files) => git(["add", "-A", "--", ...files]))
  export const unstage = (input: Input) =>
    change(Input.parse(input), "staged", async (files) =>
      (await Checkout.current())?.head
        ? git(["restore", "--staged", "--", ...files])
        : git(["update-index", "--force-remove", "--", ...files]),
    )
}
