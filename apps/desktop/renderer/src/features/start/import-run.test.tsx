import { mkdir } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"
import { Route, Router } from "@solidjs/router"
import { createEffect, createRoot } from "solid-js"
import { render } from "solid-js/web"
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import { Home } from "../../app"
import { setLocale } from "../../i18n"
import { client } from "../../state/client"
import { connectGroups } from "../../state/groups"
import { connectImport, importProgress, setImportProgress, type ImportProgress } from "../../state/import"
import { connect, setState } from "../../state/store"
import { engineFixture } from "../../test/engine"

let engine: Awaited<ReturnType<typeof engineFixture>>
let stop = () => {}
beforeAll(async () => {
  engine = await engineFixture()
  location.href = engine.url
  const stopStore = connect()
  const stopGroups = connectGroups()
  const stopImport = connectImport()
  stop = () => {
    stopImport()
    stopGroups()
    stopStore()
  }
  await client()
})
afterAll(async () => {
  stop()
  await engine.close()
})
let cleanup = () => {}
afterEach(() => {
  cleanup()
  cleanup = () => {}
})

/** The tables of data/merakcode.db in v0.3, with two conversations: one fine and one with a damaged part. */
function writeV03(root: string, directory: string) {
  const db = new DatabaseSync(path.join(root, "data", "merakcode.db"))
  db.exec(`
CREATE TABLE record (key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE message (session_id TEXT NOT NULL, id TEXT NOT NULL, written INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, id));
CREATE TABLE part (session_id TEXT NOT NULL, id TEXT NOT NULL, message_id TEXT NOT NULL, written INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, id));
CREATE TABLE review_baseline (session_id TEXT NOT NULL, path TEXT NOT NULL, data BLOB, PRIMARY KEY (session_id, path));`)
  const created = Date.UTC(2025, 4, 6, 7, 1)
  const conversation = (id: string, title: string, message: string, part: string) => {
    const info = {
      id,
      slug: `slug-${id}`,
      projectID: "proj",
      directory,
      title,
      version: "0.3.1",
      time: { created, updated: created },
    }
    db.prepare("INSERT INTO session VALUES (?, 'proj', NULL, ?, ?, ?)").run(id, title, created, JSON.stringify(info))
    const user = {
      id: message,
      sessionID: id,
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "fake", modelID: "m" },
    }
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(id, message, created, JSON.stringify(user))
    db.prepare("INSERT INTO part VALUES (?, ?, ?, 0, ?)").run(id, `${message}-part`, message, part)
  }
  conversation(
    "ses_ok",
    "Fix the build",
    "msg_1",
    JSON.stringify({ id: "p1", sessionID: "ses_ok", messageID: "msg_1", type: "text", text: "Why?" }),
  )
  conversation("ses_bad", "Broken", "msg_2", '{"type":"text","text":"cut off')
  db.close()
}

test("an import started in the engine shows its progress, and its result becomes a summary in the home inbox", async () => {
  setLocale("zh")
  await mkdir(path.join(engine.root, "data"), { recursive: true })
  writeV03(engine.root, engine.project)
  const seen: ImportProgress[] = []
  const stopWatching = createRoot((dispose) => {
    createEffect(() => seen.push(importProgress()))
    return dispose
  })
  setState("folders", [{ directory: engine.project }])
  window.history.replaceState({}, "", "/")
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={Home} />
      </Router>
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
    stopWatching()
  }
  expect((await (await client()).import.start({ from: "v0.3" })).started).toBe(true)
  await expect.poll(() => seen.at(-1), { timeout: 20000 }).toEqual({ running: false, done: 2, total: 2 })
  expect(seen).toContainEqual({ running: true, done: 0, total: 2 })
  expect(seen.filter((item) => item.running).every((item) => item.total === 2)).toBe(true)
  expect(host.querySelector('[role="progressbar"]')).toBeNull()

  const notice = () => host.querySelector<HTMLElement>('[data-notice="import"]')
  await expect.poll(() => notice()?.textContent, { timeout: 20000 }).toContain("已导入")
  expect(notice()?.textContent).toContain("对话 1")
  expect(notice()?.textContent).toContain("跳过 1 项")
  expect(notice()?.textContent).toContain("有一条对话没有导入")
  expect(notice()?.textContent).toContain("MRK-4021")
  expect(notice()?.textContent).toContain("从 v0.3 导入")
  expect(notice()?.textContent).not.toContain('"imported"')
})

test("while an import runs the home page shows a progress bar with how many are done, and it goes away when it ends", async () => {
  setLocale("en")
  setState("folders", [{ directory: engine.project }])
  window.history.replaceState({}, "", "/")
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={Home} />
      </Router>
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  const bar = () => host.querySelector<HTMLElement>('[role="progressbar"]')
  expect(bar()).toBeNull()
  setImportProgress({ running: true, done: 1, total: 3 })
  await expect.poll(() => bar()?.getAttribute("aria-valuenow")).toBe("1")
  expect(bar()?.getAttribute("aria-valuemax")).toBe("3")
  expect(host.textContent).toContain("1 / 3")
  setImportProgress({ running: false, done: 3, total: 3 })
  await expect.poll(() => bar()).toBeNull()
})
