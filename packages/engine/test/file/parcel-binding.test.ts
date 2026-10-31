import { describe, expect, test, vi } from "vitest"
import fs from "fs/promises"
import path from "path"
import { setTimeout as sleep } from "timers/promises"
import { pathToFileURL } from "url"
import { evaluate, tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

// Loaded in a real Node process: Vitest injects require into the test process, which would hide ESM-only problems
test("file watcher native module loads under Node", async () => {
  const source = pathToFileURL(path.resolve(import.meta.dirname, "../../src/infra/file/parcel-binding.ts")).href
  const result = await Process.run(
    evaluate(
      `const { parcelWatcher } = await import(${JSON.stringify(source)}); console.log(typeof parcelWatcher()?.subscribe)`,
    ),
    { nothrow: true },
  )
  expect(result.text().trim(), result.stderr.toString()).toBe("function")
})

// Unsubscribing while events for the directory are still arriving crashes the @parcel/watcher native module on
// Windows (0xC0000005) and macOS (SIGSEGV, exit 139). Every config write rebuilds the instance and resubscribes the
// config directory while the write itself produces events. Runs in a child process so a crash shows up as the exit code.
test("repeatedly unsubscribing and resubscribing while the directory changes does not crash", async () => {
  await using tmp = await tmpdir()
  const source = pathToFileURL(path.resolve(import.meta.dirname, "../../src/infra/file/parcel-binding.ts")).href
  const code = `
    import fs from "node:fs/promises"
    import path from "node:path"
    const { parcelWatcher, closeParcelWatchers } = await import(${JSON.stringify(source)})
    const watcher = parcelWatcher()
    const dir = ${JSON.stringify(tmp.path)}
    let writing = true
    let writes = 0
    const writer = (async () => {
      for (let i = 0; writing; i++, writes++) {
        const temp = path.join(dir, "merakcode.json." + i + ".tmp")
        await fs.writeFile(temp, String(i))
        // On Windows a rename fails with EPERM while another process (antivirus, indexer) reads the target; skip it
        await fs.rename(temp, path.join(dir, "merakcode.json")).catch(() => undefined)
      }
    })()
    for (let i = 0; i < 150; i++) {
      const subscription = await watcher.subscribe(dir, () => {}, { ignore: [] })
      await new Promise((resolve) => setTimeout(resolve, i % 3))
      await subscription.unsubscribe()
    }
    writing = false
    await writer
    await closeParcelWatchers()
    // The directory kept changing the whole time
    console.log("survived", writes > 20)
    // As the CLI does: on Windows the subscriptions left open keep the process alive until it exits
    process.exit(0)
  `
  const result = await Process.run(evaluate(code), { nothrow: true, timeout: 120_000 })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.text().trim()).toBe("survived true")
}, 150_000)

// Exiting while a native cancel is still running crashes on Windows (0xC0000005). Closing must wait for cancels that
// are already in flight, not only for queued ones. The crash is intermittent, so several processes run.
test("exiting right after closing watchers on busy directories does not crash", async () => {
  await using tmp = await tmpdir()
  const source = pathToFileURL(path.resolve(import.meta.dirname, "../../src/infra/file/parcel-binding.ts")).href
  const code = `
    import fs from "node:fs/promises"
    import path from "node:path"
    const { parcelWatcher, closeParcelWatchers } = await import(${JSON.stringify(source)})
    const watcher = parcelWatcher()
    const dirs = []
    for (let i = 0; i < 6; i++) {
      const dir = await fs.mkdtemp(path.join(${JSON.stringify(tmp.path)}, "busy-"))
      dirs.push(dir)
      await watcher.subscribe(dir, () => {}, { ignore: [] })
    }
    let busy = true
    const churn = (async () => {
      for (let n = 0; busy; n++)
        await Promise.all(dirs.map((dir) => fs.writeFile(path.join(dir, "f" + (n % 50)), String(n)).catch(() => {})))
    })()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await closeParcelWatchers()
    busy = false
    await churn
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})))
    process.exit(0)
  `
  for (let run = 0; run < 12; run++) {
    const result = await Process.run(evaluate(code), { nothrow: true, timeout: 60_000 })
    expect(result.exitCode, `run ${run}: ${result.stderr.toString()}`).toBe(0)
  }
}, 180_000)

// Windows and macOS queue a cancel until no watcher has events (see parcel-binding.ts). Changes in ignored paths keep the
// native watcher just as busy without reaching the callback, and under steady changes the native module reports only
// every 500 ms, so neither may let a cancel through while the directory still changes. Only Windows is checked: on a
// loaded macOS machine FSEvents can go quiet for longer than any window while files still change.
describe.runIf(process.platform === "win32")("a queued cancel", () => {
  test.each([
    ["only inside an ignored folder", "ignored"],
    ["in watched files", "."],
  ])(
    "waits while the directory keeps changing %s",
    async (_, folder) => {
      await using tmp = await tmpdir()
      await fs.mkdir(path.join(tmp.path, "ignored"))
      const { parcelWatcher, pendingParcelCancels } = await import("@merakcode/engine/infra/file/parcel-binding")
      const seen: string[] = []
      const subscription = await parcelWatcher()!.subscribe(
        tmp.path,
        (_, events) => seen.push(...events.map((event) => path.relative(tmp.path, event.path))),
        { ignore: ["ignored"] },
      )
      // Control the quiet-period clock; a loaded filesystem cannot guarantee uninterrupted real-time writes.
      // Native subscriptions, file writes and notification delivery remain real.
      if (folder === ".") {
        await fs.writeFile(path.join(tmp.path, "initial.txt"), "initial")
        await expect.poll(() => seen.includes("initial.txt"), { timeout: 10_000 }).toBe(true)
      }
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
      try {
        await fs.writeFile(path.join(tmp.path, folder, "f.txt"), "initial")
        await sleep(1_000)
        await subscription.unsubscribe()
        for (let i = 0; i < 4; i++) {
          await vi.advanceTimersByTimeAsync(500)
          await fs.writeFile(path.join(tmp.path, folder, "f.txt"), String(i))
          // timers/promises is real: let the native backend deliver this batch before moving the clock again.
          await sleep(1_000)
          expect(pendingParcelCancels()).toBe(1)
        }
        await vi.advanceTimersByTimeAsync(1_000)
        await expect.poll(() => pendingParcelCancels()).toBe(0)
      } finally {
        await subscription.unsubscribe()
        await vi.advanceTimersByTimeAsync(2_000)
        vi.useRealTimers()
      }
      // macOS also reports the watched directory itself ("") when files inside it change
      if (folder === "ignored") expect(seen.filter((file) => file.split(path.sep)[0] === "ignored")).toEqual([])
      else expect(seen.filter((file) => file.startsWith("f")).length).toBeGreaterThan(0)
    },
    30_000,
  )
})

// On Linux, subscriptions still active at exit make the @parcel/watcher inotify backend double free in static
// destructors, exiting with 134. All subscriptions must be cancellable at once before exit.
test("tracks every file watcher subscription so all can be closed before exit", async () => {
  await using tmp = await tmpdir()
  const { parcelWatcher, closeParcelWatchers, activeParcelWatchers } =
    await import("@merakcode/engine/infra/file/parcel-binding")
  const watcher = parcelWatcher()!
  const events: string[] = []
  const first = await watcher.subscribe(tmp.path, (_, list) => events.push(...list.map((e) => e.path)))
  await watcher.subscribe(tmp.path, () => {})
  expect(activeParcelWatchers()).toBe(2)
  // A subscription closed by its owner is untracked so it is not closed twice
  await first.unsubscribe()
  expect(activeParcelWatchers()).toBe(1)
  await closeParcelWatchers()
  expect(activeParcelWatchers()).toBe(0)
  await Filesystem.write(path.join(tmp.path, "after.txt"), "x")
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(events).toEqual([])
})
