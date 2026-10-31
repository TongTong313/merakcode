import { expect, test } from "vitest"
import { mkdir, readdir, rm, symlink } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { LogRecord } from "@merakcode/log"
import { runtime, tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Glob } from "@merakcode/util/glob"
import { Process } from "@merakcode/util/process"

test.each([false, true])(
  "CLI waits for product and SDK logs before exiting (command failure: %s)",
  async (failure) => {
    // Recursive removal retries at each directory level; keep persistent locks within the test deadline.
    await using tmp = await tmpdir({
      dispose: (dir) => rm(dir, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 }),
    })
    const root = path.join(tmp.path, "logs")
    const modules = path.join(tmp.path, "merakcode/node_modules")
    await mkdir(modules, { recursive: true })
    await symlink(
      path.dirname(fileURLToPath(import.meta.resolve("zod"))),
      path.join(modules, "zod"),
      process.platform === "win32" ? "junction" : "dir",
    )
    const child = Process.spawn(
      [
        ...runtime,
        // Installs the fixture before the CLI entry; runtime already registers the source loader first
        "--import",
        pathToFileURL(path.join(import.meta.dirname, "log-shutdown.fixture.ts")).href,
        path.resolve(import.meta.dirname, "../../src/index.ts"),
        // Failing command: the tool params are not an object, so debug agent throws in this process (no engine child)
        ...(failure ? ["debug", "agent", "build", "--tool", "read", "--params", "[1]"] : ["debug", "paths"]),
      ],
      {
        cwd: tmp.path,
        env: {
          ...process.env,
          HOME: path.join(tmp.path, "home"),
          USERPROFILE: path.join(tmp.path, "home"),
          APPDATA: path.join(tmp.path, "roaming"),
          LOCALAPPDATA: path.join(tmp.path, "local"),
          MERAKCODE_HOME: path.join(tmp.path, "merakcode"),
          MERAKCODE_TEST_HOME: path.join(tmp.path, "home"),
          MERAKCODE_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
          MERAKCODE_LOG_ROOT: root,
          MERAKCODE_LOG_COMPONENT: "cli",
          MERAKCODE_CLIENT: "",
          MERAKCODE_CONFIG: "",
          MERAKCODE_CONFIG_DIR: "",
          MERAKCODE_CONFIG_CONTENT: "",
          MERAKCODE_DISABLE_PROJECT_CONFIG: "true",
          MERAKCODE_DISABLE_CATALOG_FETCH: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill(), 15_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stdout + stderr).toBe(failure ? 1 : 0)
      const files = [...new Glob("**/*.ndjson").scanSync({ cwd: root, absolute: true })]
      const records = (await Promise.all(files.map((file) => Filesystem.readText(file)))).flatMap((text) =>
        text
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as LogRecord),
      )
      for (const service of ["shutdown.product", "shutdown.sdk"]) {
        expect(
          records.filter((record) => record.service === service).map((record) => record.attributes?.index),
        ).toEqual(Array.from({ length: 20 }, (_, index) => index))
      }
      if (failure) expect(records.some((record) => record.message === "fatal" && record.level === "ERROR")).toBe(true)
      expect(await readdir(path.join(root, ".state/runs"))).toEqual([])
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
    }
  },
  20_000,
)
