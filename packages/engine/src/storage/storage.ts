import { Log } from "@merakcode/log/logger"
import { randomUUID } from "node:crypto"
import { failure } from "@merakcode/log"
import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Filesystem } from "@merakcode/util/filesystem"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { Process } from "@merakcode/util/process"
import { NamedError } from "@merakcode/util/error"
import z from "zod"
import { Glob } from "@merakcode/util/glob"
import { setTimeout as delay } from "node:timers/promises"

export namespace Storage {
  const log = Log.create({ service: "storage" })

  type Migration = (dir: string) => Promise<void>

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  const MIGRATIONS: Migration[] = [
    async (dir) => {
      const project = path.resolve(dir, "../project")
      if (!(await Filesystem.isDir(project))) return
      for await (const projectDir of new Glob("*").scan({
        cwd: project,
        onlyFiles: false,
      })) {
        log.info(`migrating project ${projectDir}`)
        let projectID = projectDir
        const fullProjectDir = path.join(project, projectDir)
        let worktree = "/"

        if (projectID !== "global") {
          for await (const msgFile of new Glob("storage/session/message/*/*.json").scan({
            cwd: path.join(project, projectDir),
            absolute: true,
          })) {
            const json = await Filesystem.readJson(msgFile)
            worktree = json.path?.root
            if (worktree) break
          }
          if (!worktree) continue
          if (!(await Filesystem.isDir(worktree))) continue
          const [id] = await Process.run(["git", "rev-list", "--max-parents=0", "--all"], {
            cwd: worktree,
            nothrow: true,
          }).then((x) =>
            x
              .text()
              .split("\n")
              .filter(Boolean)
              .map((x) => x.trim())
              .toSorted(),
          )
          if (!id) continue
          projectID = id

          await Filesystem.write(
            path.join(dir, "project", projectID + ".json"),
            JSON.stringify({
              id,
              vcs: "git",
              worktree,
              time: {
                created: Date.now(),
                initialized: Date.now(),
              },
            }),
          )

          log.info(`migrating sessions for project ${projectID}`)
          for await (const sessionFile of new Glob("storage/session/info/*.json").scan({
            cwd: fullProjectDir,
            absolute: true,
          })) {
            const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
            log.info("copying", {
              sessionFile,
              dest,
            })
            const session = await Filesystem.readJson(sessionFile)
            await Filesystem.write(dest, JSON.stringify(session))
            log.info(`migrating messages for session ${session.id}`)
            for await (const msgFile of new Glob(`storage/session/message/${session.id}/*.json`).scan({
              cwd: fullProjectDir,
              absolute: true,
            })) {
              const dest = path.join(dir, "message", session.id, path.basename(msgFile))
              log.info("copying", {
                msgFile,
                dest,
              })
              const message = await Filesystem.readJson(msgFile)
              await Filesystem.write(dest, JSON.stringify(message))

              log.info(`migrating parts for message ${message.id}`)
              for await (const partFile of new Glob(`storage/session/part/${session.id}/${message.id}/*.json`).scan({
                cwd: fullProjectDir,
                absolute: true,
              })) {
                const dest = path.join(dir, "part", message.id, path.basename(partFile))
                const part = await Filesystem.readJson(partFile)
                log.info("copying", {
                  partFile,
                  dest,
                })
                await Filesystem.write(dest, JSON.stringify(part))
              }
            }
          }
        }
      }
    },
    async (dir) => {
      for await (const item of new Glob("session/*/*.json").scan({
        cwd: dir,
        absolute: true,
      })) {
        const session = await Filesystem.readJson(item)
        if (!session.projectID) continue
        if (!session.summary?.diffs) continue
        const { diffs } = session.summary
        await Filesystem.write(path.join(dir, "session_diff", session.id + ".json"), JSON.stringify(diffs))
        await Filesystem.write(
          path.join(dir, "session", session.projectID, session.id + ".json"),
          JSON.stringify({
            ...session,
            summary: {
              additions: diffs.reduce((sum: any, x: any) => sum + x.additions, 0),
              deletions: diffs.reduce((sum: any, x: any) => sum + x.deletions, 0),
            },
          }),
        )
      }
    },
  ]

  const state = lazy(async () => {
    const dir = path.join(Global.Path.data, "storage")
    const migration = await Filesystem.readJson(path.join(dir, "migration"))
      .then((x) => parseInt(x))
      .catch(() => 0)
    for (let index = migration; index < MIGRATIONS.length; index++) {
      log.info("running migration", { index })
      const migration = MIGRATIONS[index]
      await migration(dir).catch(() => log.error("failed to run migration", { index }))
      await Filesystem.write(path.join(dir, "migration"), (index + 1).toString())
    }
    return {
      dir,
    }
  })

  export async function remove(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      await fs.unlink(target).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      })
    })
  }

  export async function removePrefix(prefix: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.resolve(dir, ...prefix)
    const relative = path.relative(dir, target)
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Storage prefix must resolve below the storage root")
    }
    return withErrorHandling(() => fs.rm(target, { recursive: true, force: true }))
  }

  export async function read<T>(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.read(target)
      const result = await Filesystem.readJson(target)
      return result as T
    })
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      const content = await Filesystem.readJson(target)
      fn(content)
      await persist(target, content)
      return content as T
    })
  }

  // On Windows, readers and antivirus software may briefly lock the target; write/update share a bounded retry and
  // always keep the atomic replace.
  const RETRYABLE_ERRNOS = new Set(["EUNKNOWN", "EBUSY", "EPERM", "EACCES", "EIO"])
  const MAX_RETRIES = 10

  /**
   * The in-process Lock cannot protect readers in other workers or backends, so the file is only ever replaced
   * whole; on failure the old version stays.
   */
  async function persist(target: string, content: unknown) {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    const json = JSON.stringify(content, null, 2)
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const mode = await fs.stat(target).then(
            (stat) => stat.mode & 0o7777,
            (error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            },
          )
          await Filesystem.write(temporary, json)
          if (mode !== undefined) await fs.chmod(temporary, mode)
          await fs.rename(temporary, target)
          return
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (attempt >= MAX_RETRIES || !code || !RETRYABLE_ERRNOS.has(code)) throw error
          log.warn("storage replace retry", { attempt, ...failure(error) })
          await delay(50 * attempt)
        }
      }
    } finally {
      await fs.rm(temporary, { force: true }).catch((error: unknown) => {
        log.warn("storage temporary cleanup failed", failure(error))
      })
    }
  }

  export async function write<T>(key: string[], content: T) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      await persist(target, content)
    })
  }

  /**
   * Returns the file path for a key.
   *
   * Only for callers that need an atomic write (tmp + rename) or must observe the file directly (tests asserting its
   * location). Normal reads and writes go through read / write / update, which hold the Lock and hide the path.
   */
  export async function targetPath(key: string[]): Promise<string> {
    const dir = await state().then((x) => x.dir)
    return path.join(dir, ...key) + ".json"
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      log.error("storage op failed", failure(e))
      throw e
    })
  }

  const glob = new Glob("**/*.json")
  export async function list(prefix: string[], options?: { strict?: boolean }) {
    const dir = await state().then((x) => x.dir)
    try {
      const result = await Array.fromAsync(
        glob.scan({
          cwd: path.join(dir, ...prefix),
          onlyFiles: true,
        }),
      ).then((results) => results.map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)]))
      result.sort()
      return result
    } catch (error) {
      if (options?.strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return []
    }
  }
}
