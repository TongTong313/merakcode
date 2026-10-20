import { expect, test } from "vitest"
import path from "path"
import { pathToFileURL } from "url"
import { evaluate, tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

// Loaded in a real Node process: Vitest injects require into the test process, which would hide ESM-only problems
test("file watcher native module loads under Node", async () => {
  const source = pathToFileURL(path.resolve(import.meta.dirname, "../../src/file/parcel-binding.ts")).href
  const result = await Process.run(
    evaluate(
      `const { parcelWatcher } = await import(${JSON.stringify(source)}); console.log(typeof parcelWatcher()?.subscribe)`,
    ),
    { nothrow: true },
  )
  expect(result.text().trim(), result.stderr.toString()).toBe("function")
})

// On Windows, unsubscribing while events for the directory are still arriving makes the @parcel/watcher native module
// touch freed memory and crash (0xC0000005). Every config write rebuilds the instance and resubscribes the config
// directory while the write itself produces events. Runs in a child process so a crash shows up as the exit code.
test("repeatedly unsubscribing and resubscribing while the directory changes does not crash", async () => {
  await using tmp = await tmpdir()
  const source = pathToFileURL(path.resolve(import.meta.dirname, "../../src/file/parcel-binding.ts")).href
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
        // Windows 上目标文件正被别的进程（杀毒、索引）读着时改名会 EPERM，这一次跳过
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
    // 取消、重订期间目录一直在变
    console.log("survived", writes > 20)
  `
  const result = await Process.run(evaluate(code), { nothrow: true, timeout: 120_000 })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.text().trim()).toBe("survived true")
}, 150_000)

// On Linux, subscriptions still active at exit make the @parcel/watcher inotify backend double free in static
// destructors, exiting with 134. All subscriptions must be cancellable at once before exit.
test("tracks every file watcher subscription so all can be closed before exit", async () => {
  await using tmp = await tmpdir()
  const { parcelWatcher, closeParcelWatchers, activeParcelWatchers } =
    await import("@merakcode/engine/file/parcel-binding")
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
