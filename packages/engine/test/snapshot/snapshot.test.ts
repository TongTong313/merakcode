import { test, expect } from "vitest"
import * as fs from "fs/promises"
import path from "path"
import { Snapshot } from "@merakcode/engine/snapshot/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Global } from "@merakcode/engine/global/index"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

async function bootstrap() {
  return tmpdir({
    git: true,
    init: async (dir) => {
      await Filesystem.write(`${dir}/a.txt`, "A")
      await Filesystem.write(`${dir}/b.txt`, "B")
      return { sessionID: "test-session-" + Math.random().toString(36).slice(2) }
    },
  })
}

test("track creates backup directory", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const backupID = await Snapshot.track(tmp.extra.sessionID)
      expect(backupID).toBeTruthy()

      const backupDir = path.join(Global.Path.data, "storage", "snapshot", tmp.extra.sessionID, backupID)
      const stat = await fs.stat(backupDir).catch(() => null)
      expect(stat?.isDirectory()).toBe(true)
    },
  })
})

test("trackFile backs up existing files", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const backupID = await Snapshot.track(tmp.extra.sessionID)
      await Snapshot.trackFile(path.join(tmp.path, "a.txt"), tmp.extra.sessionID)

      const backupDir = path.join(Global.Path.data, "storage", "snapshot", tmp.extra.sessionID, backupID)
      const backupContent = await Filesystem.readText(path.join(backupDir, "a.txt"))
      expect(backupContent).toBe("A")
    },
  })
})

test("trackFile marks non-existent files for deletion", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const backupID = await Snapshot.track(tmp.extra.sessionID)
      await Snapshot.trackFile(path.join(tmp.path, "new.txt"), tmp.extra.sessionID)

      const backupDir = path.join(Global.Path.data, "storage", "snapshot", tmp.extra.sessionID, backupID)
      const deletedMarker = await Filesystem.isFile(path.join(backupDir, "new.txt.__deleted__"))
      expect(deletedMarker).toBe(true)
    },
  })
})

test("restore reverts file changes", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const backupID = await Snapshot.track(tmp.extra.sessionID)
      await Snapshot.trackFile(path.join(tmp.path, "a.txt"), tmp.extra.sessionID)

      await Filesystem.write(`${tmp.path}/a.txt`, "MODIFIED")

      await Snapshot.restore(backupID, tmp.extra.sessionID)
      const content = await Filesystem.readText(`${tmp.path}/a.txt`)
      expect(content).toBe("A")
    },
  })
})

test("restore deletes newly created files", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const backupID = await Snapshot.track(tmp.extra.sessionID)
      await Snapshot.trackFile(path.join(tmp.path, "new.txt"), tmp.extra.sessionID)

      await Filesystem.write(`${tmp.path}/new.txt`, "NEW")

      await Snapshot.restore(backupID, tmp.extra.sessionID)
      expect(await Filesystem.isFile(`${tmp.path}/new.txt`)).toBe(false)
    },
  })
})

test("revert with patches restores files", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const backupID = await Snapshot.track(tmp.extra.sessionID)
      await Snapshot.trackFile(path.join(tmp.path, "a.txt"), tmp.extra.sessionID)

      await Filesystem.write(`${tmp.path}/a.txt`, "MODIFIED")

      await Snapshot.revert(
        [{ backupID, files: [path.join(tmp.path, "a.txt")], additions: 0, deletions: 0 }],
        tmp.extra.sessionID,
      )
      const content = await Filesystem.readText(`${tmp.path}/a.txt`)
      expect(content).toBe("A")
    },
  })
})

/** Revert after a restart relies only on the on-disk backup and the patch's backupID, not in-memory activeBackups. */
test("revert after restart simulation deletes agent-created files", async () => {
  await using tmp = await bootstrap()
  const sessionID = tmp.extra.sessionID
  const newPath = path.join(tmp.path, "new.txt")
  let backupID = ""

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      backupID = await Snapshot.track(sessionID)
      await Snapshot.trackFile(newPath, sessionID)
      await Filesystem.write(newPath, "NEW")
    },
  })

  // A fresh Instance context simulates a restart; only the patch points at the on-disk backup.
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await Filesystem.isFile(newPath)).toBe(true)
      await Snapshot.revert([{ backupID, files: [newPath], additions: 1, deletions: 0 }], sessionID)
      expect(await Filesystem.isFile(newPath)).toBe(false)
    },
  })
})

test("revert after restart simulation restores deleted files", async () => {
  await using tmp = await bootstrap()
  const sessionID = tmp.extra.sessionID
  const filePath = path.join(tmp.path, "b.txt")
  let backupID = ""

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      backupID = await Snapshot.track(sessionID)
      await Snapshot.trackFile(filePath, sessionID)
      await fs.unlink(filePath)
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await Filesystem.isFile(filePath)).toBe(false)
      await Snapshot.revert([{ backupID, files: [filePath], additions: 0, deletions: 1 }], sessionID)
      expect(await Filesystem.readText(filePath)).toBe("B")
    },
  })
})

test("diff returns changes between backup and current", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const backupID = await Snapshot.track(tmp.extra.sessionID)
      await Snapshot.trackFile(path.join(tmp.path, "a.txt"), tmp.extra.sessionID)

      await Filesystem.write(`${tmp.path}/a.txt`, "MODIFIED")

      const diff = await Snapshot.diff(backupID, tmp.extra.sessionID)
      expect(diff).toContain("A")
      expect(diff).toContain("MODIFIED")
    },
  })
})

test("diffFull compares two backups", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const from = await Snapshot.track(tmp.extra.sessionID)
      await Snapshot.trackFile(path.join(tmp.path, "a.txt"), tmp.extra.sessionID)
      await Filesystem.write(`${tmp.path}/a.txt`, "MODIFIED")
      await new Promise((r) => setTimeout(r, 2))

      const to = await Snapshot.track(tmp.extra.sessionID)
      await Snapshot.trackFile(path.join(tmp.path, "a.txt"), tmp.extra.sessionID)

      const diffs = await Snapshot.diffFull(from, to, tmp.extra.sessionID)
      expect(diffs.length).toBeGreaterThan(0)
      expect(diffs[0].file).toBe(path.join(tmp.path, "a.txt"))
    },
  })
})

// The processor only tracks an empty backup at step-finish. Unless workspace files are captured into it, a new file
// is missing on both sides, diffFull skips it and session.summary counts zero lines.
test("diffFull misses a new file when the finish backup is empty and counts it after captureWorkspaceFiles", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const newFile = path.join(tmp.path, "hello.html")
      const content = "<!DOCTYPE html>\n<html>\n<body>Hello</body>\n</html>\n"

      // step-start records that the file did not exist.
      const from = await Snapshot.track(tmp.extra.sessionID)
      await Snapshot.trackFile(newFile, tmp.extra.sessionID)
      await Filesystem.write(newFile, content)
      await new Promise((r) => setTimeout(r, 2))

      // step-finish with only an empty backup misses the file.
      const to = await Snapshot.track(tmp.extra.sessionID)
      const empty = await Snapshot.diffFull(from, to, tmp.extra.sessionID)
      expect(empty).toEqual([])

      await Snapshot.captureWorkspaceFiles([newFile], tmp.extra.sessionID)
      const diffs = await Snapshot.diffFull(from, to, tmp.extra.sessionID)
      expect(diffs).toHaveLength(1)
      expect(diffs[0]).toMatchObject({
        file: newFile,
        status: "added",
        before: "",
        after: content,
      })
      expect(diffs[0].additions).toBeGreaterThan(0)
      expect(diffs[0].deletions).toBe(0)
    },
  })
})

// Likewise for edits: with an empty finish backup the old content exists only in `from`, so it looks deleted.
test("diffFull reports an edited file as deleted when the finish backup is empty and as modified after capture", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const file = path.join(tmp.path, "a.txt")
      const from = await Snapshot.track(tmp.extra.sessionID)
      await Snapshot.trackFile(file, tmp.extra.sessionID)
      await Filesystem.write(file, "MODIFIED\nline2\n")
      await new Promise((r) => setTimeout(r, 2))

      const to = await Snapshot.track(tmp.extra.sessionID)
      const broken = await Snapshot.diffFull(from, to, tmp.extra.sessionID)
      expect(broken).toHaveLength(1)
      expect(broken[0].status).toBe("deleted")

      await Snapshot.captureWorkspaceFiles([file], tmp.extra.sessionID)
      const diffs = await Snapshot.diffFull(from, to, tmp.extra.sessionID)
      expect(diffs).toHaveLength(1)
      expect(diffs[0].status).toBe("modified")
      expect(diffs[0].additions).toBeGreaterThan(0)
    },
  })
})

async function collectRelativeFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(path.relative(dir, full))
    }
  }
  await walk(dir)
  return out
}

test("backupCurrentFiles restores files when worktree is / (non-git)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(`${dir}/hello.html`, "CREATED")
      return { sessionID: "test-session-" + Math.random().toString(36).slice(2) }
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(Instance.worktree).toBe("/")
      const file = path.join(tmp.path, "hello.html")
      const backupID = await Snapshot.track(tmp.extra.sessionID)
      await Snapshot.backupCurrentFiles(backupID, tmp.extra.sessionID, [file])

      const backupDir = path.join(Global.Path.data, "storage", "snapshot", tmp.extra.sessionID, backupID)
      const encoded = await collectRelativeFiles(backupDir)
      expect(encoded.some((p) => p.replace(/\\/g, "/").includes("hello.html"))).toBe(true)
      for (const rel of encoded) {
        expect(rel.includes(":")).toBe(false)
      }

      await fs.unlink(file)
      await Snapshot.restore(backupID, tmp.extra.sessionID)
      expect(await Filesystem.readText(file)).toBe("CREATED")
    },
  })
})

test("backupCurrentFiles accepts slash-prefixed Windows drive path", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(`${dir}/hello.html`, "CREATED")
      return { sessionID: "test-session-" + Math.random().toString(36).slice(2) }
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const file = path.join(tmp.path, "hello.html")
      const slashPrefixed = file.replace(/^([A-Za-z]:)/, "\\$1")
      const backupID = await Snapshot.track(tmp.extra.sessionID)
      await Snapshot.backupCurrentFiles(backupID, tmp.extra.sessionID, [slashPrefixed])

      const backupDir = path.join(Global.Path.data, "storage", "snapshot", tmp.extra.sessionID, backupID)
      const encoded = await collectRelativeFiles(backupDir)
      for (const rel of encoded) {
        expect(rel.includes(":")).toBe(false)
      }

      await fs.unlink(file)
      await Snapshot.restore(backupID, tmp.extra.sessionID)
      expect(await Filesystem.readText(file)).toBe("CREATED")
    },
  })
})

test("backupCurrentFiles encodes Windows drive paths without colon", async () => {
  await using tmp = await tmpdir({
    init: async () => ({ sessionID: "test-session-" + Math.random().toString(36).slice(2) }),
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const backupID = await Snapshot.track(tmp.extra.sessionID)
      const fake = "D:\\UUABC_L\\Desktop\\20260907\\1\\hello.html"
      const slashPrefixed = "\\d:\\UUABC_L\\Desktop\\20260907\\1\\hello.html"
      await Snapshot.backupCurrentFiles(backupID, tmp.extra.sessionID, [fake, slashPrefixed])

      const backupDir = path.join(Global.Path.data, "storage", "snapshot", tmp.extra.sessionID, backupID)
      const encoded = await collectRelativeFiles(backupDir)
      expect(encoded.length).toBeGreaterThan(0)
      for (const rel of encoded) {
        expect(rel.includes(":")).toBe(false)
      }
      expect(encoded.some((p) => p.replace(/\\/g, "/").includes("__drive_"))).toBe(true)
    },
  })
})

test("backupCurrentFiles records mtime for manual change detection", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const backupID = await Snapshot.track(tmp.extra.sessionID)
      await Snapshot.backupCurrentFiles(backupID, tmp.extra.sessionID, ["a.txt"])

      const backupDir = path.join(Global.Path.data, "storage", "snapshot", tmp.extra.sessionID, backupID)
      const mtimeExists = await Filesystem.isFile(path.join(backupDir, ".__mtime__.json"))
      expect(mtimeExists).toBe(true)

      // No manual changes yet
      const changes = await Snapshot.checkManualChanges(backupID, tmp.extra.sessionID)
      expect(changes).toEqual([])

      // Modify file
      await Filesystem.write(`${tmp.path}/a.txt`, "CHANGED")

      const changesAfter = await Snapshot.checkManualChanges(backupID, tmp.extra.sessionID)
      expect(changesAfter).toContain(path.join(tmp.path, "a.txt"))
    },
  })
})

test("cleanup skips active session backups", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { Session } = await import("@merakcode/engine/session/index")
      const session = await Session.create({})
      const backupID = await Snapshot.track(session.id)
      await Snapshot.trackFile(path.join(tmp.path, "a.txt"), session.id)

      await Snapshot.cleanup()

      const backupDir = path.join(Global.Path.data, "storage", "snapshot", session.id, backupID)
      expect(
        await fs
          .stat(backupDir)
          .then(() => true)
          .catch(() => false),
      ).toBe(true)

      await Session.remove(session.id)
    },
  })
})

test("cleanup removes expired session backups", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { Session } = await import("@merakcode/engine/session/index")
      const session = await Session.create({})
      const backupID = await Snapshot.track(session.id)
      await Snapshot.trackFile(path.join(tmp.path, "a.txt"), session.id)

      // Simulate 8 days of inactivity.
      await Session.update(
        session.id,
        (draft) => {
          draft.time.updated = Date.now() - 8 * 24 * 60 * 60 * 1000
        },
        { touch: false },
      )

      await Snapshot.cleanup()

      const backupDir = path.join(Global.Path.data, "storage", "snapshot", session.id, backupID)
      expect(await fs.stat(backupDir).catch(() => null)).toBeNull()

      await Session.remove(session.id)
    },
  })
})

test("cleanup discards undoRedo before removing expired backups", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { Session } = await import("@merakcode/engine/session/index")
      const session = await Session.create({})
      const backupID = await Snapshot.track(session.id)

      // hiddenMessages stays empty so cleanup does not fail trying to delete real messages.
      await Session.update(
        session.id,
        (draft) => {
          draft.undoRedo = {
            stack: [
              {
                hiddenMessages: [],
                fileSnapshot: backupID,
                targetMessageID: "msg-test",
                timestamp: Date.now(),
              },
            ],
          }
        },
        { touch: false },
      )

      // Simulate 8 days of inactivity.
      await Session.update(
        session.id,
        (draft) => {
          draft.time.updated = Date.now() - 8 * 24 * 60 * 60 * 1000
        },
        { touch: false },
      )

      await Snapshot.cleanup()

      const sessionBackupDir = path.join(Global.Path.data, "storage", "snapshot", session.id)
      expect(await fs.stat(sessionBackupDir).catch(() => null)).toBeNull()

      const after = await Session.get(session.id)
      expect(after.undoRedo?.stack?.length ?? 0).toBe(0)

      await Session.remove(session.id)
    },
  })
})

test("cleanup removes orphaned backup directories", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const orphanID = "orphan-session-cleanup-test"
      const orphanDir = path.join(Global.Path.data, "storage", "snapshot", orphanID)
      await fs.mkdir(path.join(orphanDir, "backup-1"), { recursive: true })
      await Filesystem.write(path.join(orphanDir, "backup-1", "file.txt"), "orphan")

      await Snapshot.cleanup()

      expect(await fs.stat(orphanDir).catch(() => null)).toBeNull()
    },
  })
})

test("cleanup skips when already running", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { Session } = await import("@merakcode/engine/session/index")
      const session = await Session.create({})
      const backupID = await Snapshot.track(session.id)

      // The in-memory lock makes the second concurrent call skip.
      await Promise.all([Snapshot.cleanup(), Snapshot.cleanup()])

      // The session is active, so its backup must survive.
      const backupDir = path.join(Global.Path.data, "storage", "snapshot", session.id, backupID)
      expect(
        await fs
          .stat(backupDir)
          .then(() => true)
          .catch(() => false),
      ).toBe(true)

      await Session.remove(session.id)
    },
  })
})

test("cleanup does not delete backup when session belongs to another project", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { Session } = await import("@merakcode/engine/session/index")
      const session = await Session.create({})
      const backupID = await Snapshot.track(session.id)
      await Snapshot.trackFile(path.join(tmp.path, "a.txt"), session.id)

      // Move the session file under another project's directory.
      const currentProjectID = Instance.project.id
      const otherProjectID = "other-project-cleanup-test"
      const sessionSrc = path.join(Global.Path.data, "storage", "session", currentProjectID, session.id + ".json")
      const sessionDst = path.join(Global.Path.data, "storage", "session", otherProjectID, session.id + ".json")
      await fs.mkdir(path.dirname(sessionDst), { recursive: true })
      await fs.copyFile(sessionSrc, sessionDst)
      await fs.unlink(sessionSrc)

      // The backup must survive because the session is still found in the other project.
      await Snapshot.cleanup()

      const backupDir = path.join(Global.Path.data, "storage", "snapshot", session.id, backupID)
      expect(
        await fs
          .stat(backupDir)
          .then(() => true)
          .catch(() => false),
      ).toBe(true)

      await fs.rm(path.join(Global.Path.data, "storage", "session", otherProjectID), { recursive: true, force: true })
      await fs.rm(path.join(Global.Path.data, "storage", "snapshot", session.id), { recursive: true, force: true })
    },
  })
})
