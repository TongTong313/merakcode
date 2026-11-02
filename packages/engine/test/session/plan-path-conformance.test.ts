import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Session } from "../../src/agent/session"
import { SessionPlan } from "../../src/agent/session/plan"
import { Global } from "../../src/infra/global"
import { Instance } from "../../src/infra/project/instance"
import { tmpdir } from "../fixture/fixture"

test.each(["remove", "expire"])("%s validates every plan before deleting a session tree", async (action) => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      const child = await Session.create({ parentID: root.id })
      const plans = path.join(Global.Path.data, "plans")
      const backup = plans + "-saved"
      const moved = await fs.rename(plans, backup).then(
        () => true,
        (e) => {
          if (e.code !== "ENOENT") throw e
          return false
        },
      )
      await fs.mkdir(Global.Path.data, { recursive: true })
      const target = path.join(tmp.path, path.basename(Session.plan(child)))
      await fs.writeFile(target, "PROJECT_CONTENT")
      await fs.symlink(tmp.path, plans, process.platform === "win32" ? "junction" : "dir")
      try {
        await expect(
          action === "expire" ? Session.expire(Date.now() + 1000) : Session.removeRecords(root.id),
        ).rejects.toThrow(/conflict/i)
        expect(await fs.readFile(target, "utf8")).toBe("PROJECT_CONTENT")
        expect((await Session.get(root.id)).id).toBe(root.id)
        expect((await Session.get(child.id)).id).toBe(child.id)
      } finally {
        await fs.unlink(plans)
        if (moved) await fs.rename(backup, plans)
      }
    },
  })
})

test("a redirected plans directory cannot turn a plan save into a project write", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const plans = path.join(Global.Path.data, "plans")
      await fs.mkdir(Global.Path.data, { recursive: true })
      await fs.symlink(tmp.path, plans, process.platform === "win32" ? "junction" : "dir")
      try {
        await expect(
          SessionPlan.save({
            sessionID: session.id,
            content: "must not reach project",
            source: "agent",
            expectedRevision: 0,
          }),
        ).rejects.toThrow(/conflict/i)
        const target = path.join(tmp.path, path.basename(Session.plan(session)))
        expect(
          await fs.stat(target).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
      } finally {
        await fs.unlink(plans)
      }
    },
  })
})

test("deleting the last owner removes both the migrated and legacy plan", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const first = await Session.create({})
      const second = await Session.create({})
      await Session.update(second.id, (draft) => {
        draft.slug = first.slug
        draft.time.created = first.time.created
      })
      const legacy = path.join(Global.Path.data, "plans", `${first.time.created}-${first.slug}.md`)
      await fs.mkdir(path.dirname(legacy), { recursive: true })
      await fs.writeFile(legacy, "LEGACY_PLAN")
      const a = await SessionPlan.get(first.id)
      const b = await SessionPlan.get(second.id)
      expect(a.content).toBe("LEGACY_PLAN")
      expect(b.content).toBe("LEGACY_PLAN")
      await Session.removeRecords(first.id)
      expect(await fs.readFile(legacy, "utf8")).toBe("LEGACY_PLAN")
      expect(await fs.stat(a.path).catch(() => undefined)).toBeUndefined()
      await Session.removeRecords(second.id)
      expect(await fs.stat(legacy).catch(() => undefined)).toBeUndefined()
      expect(await fs.stat(b.path).catch(() => undefined)).toBeUndefined()
    },
  })
})

test("a case alias owned by another session preserves its unmigrated legacy plan", async (context) => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const first = await Session.create({})
      const second = await Session.create({})
      await Session.update(second.id, (draft) => {
        draft.slug = first.slug.toUpperCase()
        draft.time.created = first.time.created
      })
      const legacy = path.join(Global.Path.data, "plans", `${first.time.created}-${first.slug}.md`)
      const alias = path.join(Global.Path.data, "plans", `${first.time.created}-${first.slug.toUpperCase()}.md`)
      await fs.mkdir(path.dirname(legacy), { recursive: true })
      await fs.writeFile(legacy, "SHARED_HUMAN_PLAN")
      const original = await fs.stat(legacy)
      const other = await fs.stat(alias).catch((error) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!other || original.dev !== other.dev || original.ino !== other.ino) return context.skip()
      await SessionPlan.get(first.id)
      await Session.removeRecords(first.id)
      expect((await Session.get(second.id)).id).toBe(second.id)
      expect((await SessionPlan.get(second.id)).content).toBe("SHARED_HUMAN_PLAN")
      await Session.removeRecords(second.id)
      expect(await fs.stat(legacy).catch(() => undefined)).toBeUndefined()
    },
  })
})
