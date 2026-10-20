import { expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { platformPackage } from "../../bin/cli-name.cjs"

/** Lays out the main package and this machine's platform package the way a global npm install does */
async function install(root: string, entry: string) {
  const main = path.join(root, "node_modules", "merakcode")
  for (const name of ["merak", "cli-name.cjs"])
    await Filesystem.copy(path.resolve(import.meta.dirname, "../../bin", name), path.join(main, "bin", name))
  await Filesystem.write(path.join(main, "package.json"), JSON.stringify({ name: "merakcode", type: "commonjs" }))
  const pkg = path.join(root, "node_modules", platformPackage(process.platform, process.arch))
  const node = path.join(pkg, "node", process.platform === "win32" ? "node.exe" : "bin/node")
  await fs.mkdir(path.dirname(node), { recursive: true })
  await fs.copyFile(process.execPath, node)
  await Filesystem.write(path.join(pkg, "lib", "index.js"), entry)
  return path.join(main, "bin")
}

async function launch(bin: string) {
  const proc = Process.spawn([process.execPath, path.join(bin, "merak"), "first", "second"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

test("runs lib/index.js with the platform package's own node and passes arguments through", async () => {
  await using tmp = await tmpdir()
  const bin = await install(tmp.path, "console.log(JSON.stringify(process.argv.slice(2)))")
  const { stdout, stderr, code } = await launch(bin)
  expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual(["first", "second"])
})

test("passes the exit code through", async () => {
  await using tmp = await tmpdir()
  const bin = await install(tmp.path, "process.exit(7)")
  expect((await launch(bin)).code).toBe(7)
})

test("names the missing platform package and how to reinstall", async () => {
  await using tmp = await tmpdir()
  const bin = await install(tmp.path, "")
  await fs.rm(path.join(tmp.path, "node_modules", platformPackage(process.platform, process.arch)), { recursive: true })
  const { stderr, code } = await launch(bin)
  expect(code).toBe(1)
  expect(stderr).toContain(platformPackage(process.platform, process.arch))
  expect(stderr).toContain("npm install -g merakcode")
})
