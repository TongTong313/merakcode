import { afterEach, describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { Worktree } from "@merakcode/engine/worktree/index"
import { tmpdir } from "../fixture/fixture"

describe("Session.workspaceFolders", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("multi-root session creation stores workspaceFolders while list still uses the primary directory", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: async () => {
        const created = await Session.create({ title: "multi-root-session" })
        try {
          expect(created.workspaceFolders).toHaveLength(2)
          expect(created.workspaceFolders?.map((f) => f.name)).toEqual(["alpha", "beta"])
          expect(created.directory).toBe(Instance.directory)
          // list goes by project/primary: the session directory is the primary, never the second root.
          const listed: Session.Info[] = []
          for await (const s of Session.list()) {
            if (s.id === created.id) listed.push(s)
          }
          expect(listed).toHaveLength(1)
          expect(listed[0]!.directory).toBe(a.path)
          expect(listed[0]!.directory).not.toBe(b.path)
        } finally {
          await Session.remove(created.id)
        }
      },
    })
  })

  test("single-root session creation does not store workspaceFolders", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await Session.create({ title: "single-root-session" })
        try {
          expect(created.workspaceFolders).toBeUndefined()
        } finally {
          await Session.remove(created.id)
        }
      },
    })
  })
})

describe("Worktree multi-root disabled", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("creating a worktree on a multi-root Instance throws", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: async () => {
        let err: unknown
        try {
          await Worktree.create({})
        } catch (e) {
          err = e
        }
        expect(err).toBeDefined()
        const message = err instanceof Error ? err.message : String(err)
        const data = (err as { data?: { message?: string } })?.data?.message
        expect(`${message} ${data ?? ""}`).toMatch(/multi-root/i)
      },
    })
  })
})
